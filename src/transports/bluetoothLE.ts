import { Platform } from 'react-native';
import { TransportError } from '../errors';
import { toArrayBuffer } from '../native';
import type { BleConnection } from '../specs/BleConnection.nitro';
import type { ReadOptions, Transport } from '../transport';
import { classify, native, sleep, stripUndefined, wrap } from './bleCommon';
import {
  BleGattCharacteristic,
  BleSelection,
  BleSelectionOptions,
  BleSelector,
  BleWriteMode,
  selectCharacteristics,
} from './bleGatt';
import type {
  BleConnectionState,
  BleConnectionStateEvent,
  BleDiagnostics,
  BleGattReading,
  BleWriteOptions,
  BleWriteStats,
  BluetoothLETransportOptions,
} from './bleTypes';
import { chunkBytes } from './chunk';
import { shortUuid } from './sig';
import { Inbox } from './inbox';

export * from './bleTypes';
export { classify } from './bleCommon';
export { BleDeviceConnection, BluetoothLE, bleFilters } from './bleScan';


/** The native side has its own time limit; this guard is for a native promise that never settles. */
const GUARD_MARGIN_MS = 1000;
const DEFAULT_BOND_TIMEOUT_MS = 30000;
/** A disconnect within this time after a write without response asks the printer one question first (see `drain`). */
const DRAIN_WINDOW_MS = 2000;
const DRAIN_GUARD_MS = 1500;
const DEVICE_NAME = '2a00';
const LOWEST_PAYLOAD = 20; // the smallest BLE packet: MTU 23 minus 3

/**
 * Sends printer bytes over Bluetooth Low Energy. It works on Android and iOS and knows nothing
 * about the command language: it moves bytes. No UUID is built in. After the link is up it reads
 * the GATT table from the device and picks the characteristics (see `selectCharacteristics`).
 *
 * `LabelPrinter` reconnects through `connect()`. This class has no retry loop of its own.
 */
export class BluetoothLETransport implements Transport {
  private readonly deviceId: string;
  private readonly settings: BluetoothLETransportOptions;
  private readonly inbox = new Inbox();
  private readonly stateListeners = new Set<(event: BleConnectionStateEvent) => void>();

  private link: BleConnection | null = null;
  private state: BleConnectionState = 'disconnected';
  private picked: BleSelection | null = null;
  private table: BleGattCharacteristic[] = [];
  private lastUnacknowledgedWriteAt = 0;
  private writeChain: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private lostReason: string | null = null;
  private cancelled = false;
  /** Pairing is tried once for each connection: a device that stays unpaired must not make a loop. */
  private bondTried = false;
  private unsubscribe: (() => Promise<void>) | null = null;
  private mtuRequestText = 'not asked yet';
  private connectMs: number | null = null;
  private discoverMs: number | null = null;
  private lastWriteStats: BleWriteStats | null = null;

  /** `device` is a scan result or its id. The transport opens its own link, so it can open it again later. */
  constructor(device: string | { id: string }, options: BluetoothLETransportOptions = {}) {
    this.deviceId = typeof device === 'string' ? device : device.id;
    const p = options.profile;
    // Options win over the profile.
    this.settings = { ...stripUndefined(p ?? {}), ...stripUndefined(options) };
  }

  /** The characteristic table found on the last connect. Empty before the first connect. */
  get gatt(): readonly BleGattCharacteristic[] {
    return this.table;
  }

  /** What the transport chose to write to and listen on. null when not connected. */
  get selection(): BleSelection | null {
    return this.picked;
  }

  get connectionState(): BleConnectionState {
    return this.state;
  }

  /** Be told about connect, disconnect and unexpected link loss. Returns a function that removes the listener. */
  onConnectionState(listener: (event: BleConnectionStateEvent) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Stop the write that runs now, between two pieces. The write rejects with E_CANCELLED and the link closes. */
  cancel(): void {
    this.cancelled = true;
  }

  async connect(): Promise<void> {
    await this.disconnect();
    const mod = native();
    const gen = ++this.generation;
    this.lostReason = null;
    this.cancelled = false;
    this.bondTried = false;
    this.setState('connecting');
    let link: BleConnection | null = null;
    this.mtuRequestText = 'skipped';
    this.connectMs = null;
    this.discoverMs = null;
    try {
      const t0 = Date.now();
      link = await wrap(
        mod.connect(this.deviceId, this.settings.connectTimeoutMs ?? 10000, (reason) => this.onLinkLost(gen, reason)),
        'E_CONNECT'
      );
      // disconnect() or a newer connect() came while this one opened: this link is not wanted. Close it, touch nothing else.
      this.assertWanted(gen);
      this.link = link;
      this.connectMs = Date.now() - t0;

      await this.requestMtu(link);

      const t1 = Date.now();
      const table = [...(await wrap(link.discover(), 'E_DISCOVERY'))];
      this.assertWanted(gen);
      this.table = table;
      this.discoverMs = Date.now() - t1;
      this.picked = selectCharacteristics(this.table, this.settings);

      await this.subscribeToNotifications(link, gen);
      // The link can be lost during the steps above (the native side calls onLinkLost, which bumps nothing by itself).
      this.assertWanted(gen);
      if (!link.isConnected) throw new TransportError('The connection was closed while it opened', 'E_DISCONNECTED');
      this.setState('connected');
    } catch (e) {
      // Only the newest connect owns the fields. An older one that failed must not wipe the newer link.
      if (gen === this.generation) {
        this.link = null;
        this.picked = null;
      }
      if (link) await link.disconnect().catch(() => undefined);
      const error = classify(e, 'E_CONNECT');
      if (gen === this.generation) this.setState('disconnected', error.message, error);
      throw error;
    }
  }

  /** disconnect() or a newer connect() came while this one opened: this link is not wanted. */
  private assertWanted(gen: number): void {
    if (gen !== this.generation) throw new TransportError('The connection was closed while it opened', 'E_DISCONNECTED');
  }

  /** Android: ask for a bigger MTU. A refused request is fine: the link keeps the default MTU, and the piece size follows it. */
  private async requestMtu(link: BleConnection): Promise<void> {
    const wanted = this.settings.requestMtu ?? 247;
    if (wanted === false || Platform.OS !== 'android') return;
    this.mtuRequestText = await link.requestMtu(wanted).then(
      (got) => `asked ${wanted}, got ${got}`,
      (e: unknown) => `asked ${wanted}, failed: ${classify(e, 'E_TIMEOUT').message}`
    );
  }

  /** Subscribe to the reply characteristic. Printing works without replies; only status queries are lost when this fails. */
  private async subscribeToNotifications(link: BleConnection, gen: number): Promise<void> {
    const notify = this.settings.subscribe === false ? null : this.picked?.notify;
    if (!notify) return;
    const { serviceUuid, uuid } = notify;
    try {
      await this.withBond(link, () =>
        wrap(
          // A late notification of an old link must not land in the inbox of the next one.
          link.subscribe(serviceUuid, uuid, (data) => {
            if (gen === this.generation) this.inbox.push(new Uint8Array(data));
          }),
          'E_NOTIFY'
        )
      );
      this.unsubscribe = () => link.unsubscribe(serviceUuid, uuid);
    } catch {
      this.unsubscribe = null;
    }
  }

  /** Close the link and connect again. Not a retry loop: it runs once, when you call it. */
  async reconnect(): Promise<void> {
    await this.disconnect();
    await this.connect();
  }

  async disconnect(): Promise<void> {
    const link = this.link;
    await this.drain(link);
    this.generation++; // late callbacks from the old link are ignored
    this.link = null;
    this.picked = null;
    this.inbox.clear();
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = null;
    if (!link) return;
    this.setState('disconnecting');
    await unsubscribe?.().catch(() => undefined);
    try {
      await wrap(link.disconnect(), 'E_DISCONNECTED');
    } finally {
      this.setState('disconnected', 'requested');
    }
  }

  /**
   * Before the link is closed after a write without response: the data may still sit in the phone's queue, and a close drops it (Android frees
   * the queued data of a closed channel; the Linux rule is the same: a close without linger drops the unsent data of the socket). A request that
   * the printer answers is ordered after the commands before it on the same channel, so its answer says the commands were sent.
   * The Device Name (0x2A00) is read, because every GATT server has it. The answer is not used, and a failure does not matter.
   */
  private async drain(link: BleConnection | null): Promise<void> {
    if (!link || Date.now() - this.lastUnacknowledgedWriteAt > DRAIN_WINDOW_MS || !link.isConnected) return;
    const name = this.table.find((c) => c.read && shortUuid(c.uuid) === DEVICE_NAME);
    if (!name) return;
    this.lastUnacknowledgedWriteAt = 0;
    await withGuard(wrap(link.read(name.serviceUuid, name.uuid), 'E_READ'), DRAIN_GUARD_MS, 'Drain timed out').catch(() => undefined);
  }

  async isConnected(): Promise<boolean> {
    return this.link !== null && (this.state === 'connected' || this.state === 'writing') && this.link.isConnected;
  }

  /**
   * Send bytes, unchanged. Splits them to the largest piece the link takes, sends one piece at a time and
   * waits for the stack before the next (flow control). Rejects with E_TIMEOUT, E_DISCONNECTED, E_CANCELLED or E_WRITE.
   */
  write(data: Uint8Array, options: BleWriteOptions = {}): Promise<void> {
    const run = this.writeChain.then(() => this.writeNow(data, options));
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  read(options: ReadOptions = {}): Promise<Uint8Array> {
    return this.inbox.read(options);
  }

  /**
   * Read every characteristic that has the read property, one after the other, like a generic GATT client does
   * (nRF Connect). One failed read does not stop the others: it shows as `error` on its row. Nothing is written.
   * It waits for a running write, so it never shares the link with a print job. NOT checked on a printer.
   */
  readGatt(): Promise<BleGattReading[]> {
    const run = this.writeChain.then(() => this.readGattNow());
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  private async readGattNow(): Promise<BleGattReading[]> {
    const link = this.link;
    if (!link || this.state !== 'connected') throw new TransportError('The printer is not connected', 'E_NOT_CONNECTED');
    const out: BleGattReading[] = [];
    for (const c of this.table) {
      const row = await readCharacteristic(link, c);
      out.push(row);
      // The link is gone: the rest cannot be read either.
      if (row.error?.code === 'E_DISCONNECTED') throw new TransportError(row.error.message, 'E_DISCONNECTED');
    }
    return out;
  }

  /** Bytes per write on the current link. */
  get payloadSize(): number {
    const link = this.link;
    const pick = this.picked;
    if (!link || !pick) return LOWEST_PAYLOAD;
    const limit = link.maxWriteLength(pick.withResponse);
    const native = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : LOWEST_PAYLOAD;
    const cap = this.settings.chunkSize;
    return Math.max(1, cap !== undefined ? Math.min(cap, native) : native);
  }

  /** The state of the link and the numbers behind it. For tests and logs. */
  diagnostics(): BleDiagnostics {
    const link = this.link;
    const pick = this.picked;
    const live = link !== null && pick !== null;
    return {
      state: this.state,
      bondState: link ? link.bondState ?? null : null,
      deviceId: this.deviceId,
      writeModeRequested: this.settings.writeMode ?? 'auto',
      withResponse: pick ? pick.withResponse : null,
      writeCharacteristic: pick ? { serviceUuid: pick.write.serviceUuid, uuid: pick.write.uuid } : null,
      notifyCharacteristic: pick?.notify ? { serviceUuid: pick.notify.serviceUuid, uuid: pick.notify.uuid } : null,
      mtu: link ? link.mtu : null,
      mtuRequest: this.mtuRequestText,
      payloadSize: live ? this.payloadSize : null,
      chunkDelayMs: pick ? this.settings.chunkDelayMs ?? (pick.withResponse ? 0 : 10) : null,
      noResponseCallback: link ? link.noResponseCallback : null,
      connectMs: this.connectMs,
      discoverMs: this.discoverMs,
      lastWrite: this.lastWriteStats,
    };
  }

  // ---- internals ----

  private async writeNow(data: Uint8Array, options: BleWriteOptions): Promise<void> {
    const link = this.link;
    const pick = this.picked;
    if (!link || !pick || this.state !== 'connected') throw new TransportError('Not connected', 'E_NOT_CONNECTED');
    this.cancelled = false;
    const gen = this.generation;
    const pieces = chunkBytes(data, this.payloadSize);
    const delay = this.settings.chunkDelayMs ?? defaultChunkDelayMs(pick.withResponse);
    const timeoutMs = this.settings.writeTimeoutMs ?? 5000;
    if (pieces.length === 0) return;

    this.setState('writing');
    let sent = 0;
    let started = false; // true once a native write began: from then on a piece may be in the printer
    const startedAt = Date.now();
    const stats = (error?: TransportError): BleWriteStats => ({
      bytes: data.length,
      chunks: pieces.length,
      payloadSize: pieces[0]?.length ?? 0,
      chunkDelayMs: delay,
      withResponse: pick.withResponse,
      sentBytes: sent,
      durationMs: Date.now() - startedAt,
      ok: !error,
      errorCode: error?.code,
      errorMessage: error?.message,
    });
    try {
      for (const [index, piece] of pieces.entries()) {
        if (this.cancelled || options.signal?.aborted) {
          throw new TransportError(`Write cancelled after ${sent} of ${data.length} bytes`, 'E_CANCELLED');
        }
        if (gen !== this.generation || !link.isConnected) {
          throw new TransportError(`The device disconnected after ${sent} of ${data.length} bytes: ${this.lostReason ?? 'link lost'}`, 'E_DISCONNECTED');
        }
        started = true;
        await this.writePiece(link, pick, piece, index === 0 ? this.firstPieceTimeoutMs(pick, timeoutMs) : timeoutMs, sent, data.length);
        sent += piece.length;
        options.onProgress?.(sent, data.length);
        if (delay > 0 && index < pieces.length - 1) await sleep(delay);
      }
    } catch (e) {
      const error = classify(e, 'E_WRITE');
      // Say what went out, so the caller can tell a failure that sent nothing (safe to send again) from one that may have printed.
      error.bytesSent = sent;
      // A refused first piece (the device wants pairing) was not accepted: nothing is in the printer.
      error.nothingSent = !started || (error.code === 'E_AUTH' && sent === 0);
      this.lastWriteStats = stats(error);
      // The printer may hold half a job, and a native write may still be pending. Close the link,
      // so no later write can follow a failed one. The next job opens a clean link.
      await this.failLink(gen, error);
      throw error;
    }
    this.lastWriteStats = stats();
    // A write without response is complete when it is handed to the stack, not when the printer has it: remember it for `disconnect()`.
    if (!pick.withResponse) this.lastUnacknowledgedWriteAt = Date.now();
    // The link may be lost during the last piece: do not say 'connected' for a link that is gone.
    if (gen === this.generation && this.link === link) this.setState('connected');
  }

  /**
   * Do `op`. When it fails with `E_AUTH` (the device wants an encrypted link), pair once for this connection, wait for the result and do `op`
   * again. Sources: Nordic Android-BLE-Library and Punch Through (bond only when the device asks, wait for the bond result, then redo the
   * operation). A device that stays unpaired reports `E_AUTH`, never a loop.
   */
  private async withBond<T>(link: BleConnection, op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (e) {
      const error = classify(e, 'E_WRITE');
      if (error.code !== 'E_AUTH' || (this.settings.bond ?? 'auto') === 'never' || this.bondTried) throw error;
      this.bondTried = true;
      // The phone may already hold a bond the printer has forgotten. Android then reports BONDED but the link stays
      // unencrypted (Nordic's BleManagerHandler documents this), and iOS reports peerRemovedPairingInformation.
      const hadBond = link.bondState === 'bonded';
      const bonded = await wrap(link.bond(this.settings.bondTimeoutMs ?? DEFAULT_BOND_TIMEOUT_MS), 'E_AUTH');
      if (!bonded) throw new TransportError('The device was not paired. Accept the pairing request on the phone, then try again.', 'E_AUTH');
      // Some devices close the link after pairing. The caller connects again; the device is paired now.
      if (!link.isConnected) throw new TransportError('The link closed after pairing. Connect again.', 'E_DISCONNECTED');
      try {
        return await op();
      } catch (again) {
        const second = classify(again, 'E_WRITE');
        if (second.code === 'E_AUTH' && hadBond) {
          throw new TransportError(
            'The phone has a pairing for this device that the device no longer knows. Open the Bluetooth settings, forget the device, then connect again.',
            'E_AUTH'
          );
        }
        throw second;
      }
    }
  }

  private async failLink(gen: number, error: TransportError): Promise<void> {
    // A lost or closed link was reported already.
    if (gen !== this.generation || this.link === null) return;
    const link = this.link;
    this.generation++;
    this.link = null;
    this.picked = null;
    this.unsubscribe = null;
    this.setState('disconnected', error.message, error);
    await link?.disconnect().catch(() => undefined);
  }

  /**
   * iOS has no bond call: the system shows its pairing dialog when the first write that needs encryption arrives, and answers that write
   * only after the person has typed the code. So the first piece gets the pairing time as well (read from Apple's docs: not run on an iPhone).
   */
  private firstPieceTimeoutMs(pick: BleSelection, timeoutMs: number): number {
    if (Platform.OS !== 'ios' || !pick.withResponse) return timeoutMs;
    return timeoutMs + (this.settings.bondTimeoutMs ?? DEFAULT_BOND_TIMEOUT_MS);
  }

  private async writePiece(
    link: BleConnection,
    pick: BleSelection,
    piece: Uint8Array,
    timeoutMs: number,
    offset: number,
    total: number
  ): Promise<void> {
    const attempt = () =>
      withGuard(
        wrap(link.write(pick.write.serviceUuid, pick.write.uuid, toArrayBuffer(piece), pick.withResponse, timeoutMs), 'E_WRITE'),
        timeoutMs + GUARD_MARGIN_MS,
        `Write timed out after ${timeoutMs} ms`
      );
    try {
      // The guard covers each native write, not the pairing in between: a pairing has its own time limit (`bondTimeoutMs`).
      await this.withBond(link, attempt);
    } catch (e) {
      const error = classify(e, 'E_WRITE');
      throw new TransportError(`${error.message} (${offset} of ${total} bytes sent)`, error.code);
    }
  }

  private onLinkLost(gen: number, reason: string): void {
    if (gen !== this.generation) return; // an old link, or a close that we asked for
    this.lostReason = reason;
    this.link = null;
    this.picked = null;
    this.unsubscribe = null;
    this.setState('disconnected', reason);
  }

  private setState(state: BleConnectionState, reason?: string, error?: TransportError): void {
    this.state = state;
    for (const l of [...this.stateListeners]) l({ state, reason, error });
  }
}

export type { BleSelection, BleSelectionOptions, BleSelector, BleWriteMode, BleGattCharacteristic };

/** One characteristic as the inspector shows it: its value, or why it could not be read. */
async function readCharacteristic(link: BleConnection, c: BleGattCharacteristic): Promise<BleGattReading> {
  const row: BleGattReading = { ...c };
  if (!c.read) return row;
  try {
    row.value = new Uint8Array(await link.read(c.serviceUuid, c.uuid));
  } catch (e) {
    const error = classify(e, 'E_READ');
    row.error = { code: error.code ?? 'E_READ', message: error.message };
  }
  return row;
}

/** `promise`, or an E_TIMEOUT when it does not settle in `ms`. */
async function withGuard<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TransportError(message, 'E_TIMEOUT')), ms);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The pause between two pieces. A write with response waits for the answer, so none. On iOS none either: CoreBluetooth says when the next write
 * without response may go (`canSendWriteWithoutResponse`, `peripheralIsReady`), and the Swift side waits for it. Elsewhere 10 ms: our choice, not
 * measured on the printer (see AGENTS.md).
 */
function defaultChunkDelayMs(withResponse: boolean): number {
  return withResponse || Platform.OS === 'ios' ? 0 : 10;
}
