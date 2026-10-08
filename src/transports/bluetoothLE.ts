import { PermissionsAndroid, Platform } from 'react-native';
import { TransportError, UnsupportedPlatformError } from '../errors';
import { getBluetoothLE, toArrayBuffer } from '../native';
import type { BleConnection } from '../specs/BleConnection.nitro';
import type { BleScanResult } from '../specs/BleScanResult';
import type { BluetoothLE as NativeBluetoothLE } from '../specs/BluetoothLE.nitro';
import type { AbortSignalLike, LinkEvent, LinkState, ReadOptions, Transport, WriteOptions } from '../transport';
import {
  BleGattCharacteristic,
  BleSelection,
  BleSelectionOptions,
  BleSelector,
  BleWriteMode,
  describeGatt,
  normalizeUuid as normalize,
  selectCharacteristics,
} from './bleGatt';
import { chunkBytes } from './chunk';
import { Inbox } from './inbox';

// ---------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------

export type BleAdapterState = 'on' | 'off' | 'unauthorized' | 'unsupported' | 'resetting' | 'unknown';

/** A device seen in a scan. Nothing here says it is a printer. */
export interface BleDevice {
  /** Pass it to `BluetoothLE.connect()` or `new BluetoothLETransport()`. Android: MAC. iOS: a UUID made by iOS. */
  id: string;
  name: string | null;
  /** dBm. null when the platform gives none. */
  rssi: number | null;
  connectable: boolean;
  /** Advertised service UUIDs, lower case, 128-bit form. */
  serviceUuids: string[];
  /** Hex of the first manufacturer block: 2-byte company id (little endian), then data. null when none. */
  manufacturerData: string | null;
  txPower: number | null;
}

export type { AbortSignalLike } from '../transport';

export interface BluetoothLEScanOptions {
  /** Ask the platform to report only devices that advertise one of these services. Default: all. */
  serviceUuids?: string[] | undefined;
  /** Stop after this many ms. Default 5000. 0 means "until stopScan() or the signal". */
  timeoutMs?: number | undefined;
  /** Keep updating the RSSI of devices already seen. Default false. */
  allowDuplicates?: boolean | undefined;
  /** Keep only devices where this returns true. Runs in TypeScript. See `bleFilters`. */
  filter?: ((device: BleDevice) => boolean) | undefined;
  /** Called at once for each new device that passes the filter. Use it to fill a list on screen. */
  onDevice?: ((device: BleDevice) => void) | undefined;
  /** Abort to stop the scan. The promise then resolves with the devices found so far. */
  signal?: AbortSignalLike | undefined;
}

export interface BleConnectOptions {
  /** Give up after this many ms. Default 10000. */
  timeoutMs?: number | undefined;
}

/**
 * Life cycle of the link and of a write:
 * `connecting` > `connected` > `writing` > `connected` (write completed) ... > `disconnecting` > `disconnected`.
 * A failed write, a timeout, a cancel and a lost link all end in `disconnected`, with `reason` and `error`.
 */
export type BleConnectionState = LinkState;

export interface BleConnectionStateEvent extends LinkEvent {
  /** The error that ended the link, when there was one (a failed write or connect). Not set for a plain disconnect or a lost link. */
  error?: TransportError | undefined;
}

/**
 * Optional description of one kind of printer. The package has none built in.
 * Make your own and pass it as `profile`, or use `matches` to find printers in a scan.
 * Settings in `BluetoothLETransportOptions` win over the profile.
 */
export interface BlePrinterProfile extends BleSelectionOptions {
  /** A label for your own use. */
  name?: string | undefined;
  /** The command language the printer speaks. The transport does not use it. */
  protocol?: 'BPLZ' | 'BPLC' | 'BPLA' | 'ZPL' | 'CPCL' | (string & {}) | undefined;
  /** Decide whether a scanned device belongs to this profile. */
  matches?: ((device: BleDevice) => boolean) | undefined;
  chunkSize?: number | undefined;
  chunkDelayMs?: number | undefined;
  requestMtu?: number | false | undefined;
}

export interface BluetoothLETransportOptions extends BleSelectionOptions {
  profile?: BlePrinterProfile | undefined;
  /**
   * Ask for this ATT MTU after connect. Android only. Default 247. `false` skips the request.
   * The device can agree to less. The transport uses the agreed value.
   */
  requestMtu?: number | false | undefined;
  /** Upper limit for one write, in bytes. The link limit still applies. Default: the link limit. */
  chunkSize?: number | undefined;
  /**
   * Wait this long between pieces, in ms. Default 0 for write with response.
   * Default 10 for write without response, because the printer cannot tell you when its buffer is full.
   * Neither default is checked on a printer.
   */
  chunkDelayMs?: number | undefined;
  /** Connect timeout in ms. Default 10000. */
  connectTimeoutMs?: number | undefined;
  /** Timeout for one write piece in ms. Default 5000. */
  writeTimeoutMs?: number | undefined;
  /** Turn on notifications for printer replies (status queries). Default true. */
  subscribe?: boolean | undefined;
}

/** One row of the GATT table, with the value when the characteristic can be read. */
export interface BleGattReading extends BleGattCharacteristic {
  value?: Uint8Array;
  error?: { code: string; message: string };
}

/** What one `write()` did. For tests and logs. */
export interface BleWriteStats {
  bytes: number;
  /** Pieces the job was split into. */
  chunks: number;
  /** Bytes in one piece (the last one can be smaller). */
  payloadSize: number;
  chunkDelayMs: number;
  withResponse: boolean;
  /** Bytes the stack accepted before the write ended. */
  sentBytes: number;
  durationMs: number;
  ok: boolean;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
}

/** The state of the link and the numbers behind it, for tests and logs (`transport.diagnostics()`). */
export interface BleDiagnostics {
  state: BleConnectionState;
  deviceId: string;
  /** The `writeMode` that was asked for. */
  writeModeRequested: BleWriteMode;
  /** What the transport uses: true = write with response. null when not connected. */
  withResponse: boolean | null;
  writeCharacteristic: { serviceUuid: string; uuid: string } | null;
  notifyCharacteristic: { serviceUuid: string; uuid: string } | null;
  /** The ATT MTU of the link (an estimate on iOS). null when not connected. */
  mtu: number | null;
  /** What the MTU request did: `skipped`, `asked 247, got 185`, or `asked 247, failed: ...`. */
  mtuRequest: string;
  /** Bytes in one write on this link (after `chunkSize`). null when not connected. */
  payloadSize: number | null;
  /** The wait between pieces that is used (the default of the write type, or `chunkDelayMs`). null when not connected. */
  chunkDelayMs: number | null;
  /** Android: did the first write without response get a callback (`yes`, `no`, `unknown`). iOS: `not applicable`. */
  noResponseCallback: string | null;
  connectMs: number | null;
  discoverMs: number | null;
  lastWrite: BleWriteStats | null;
}

export type BleWriteOptions = WriteOptions;

// ---------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------

/**
 * Nitro passes only the message of a native error. The native side puts a code first,
 * like `[E_BLUETOOTH_OFF] Bluetooth is off`. If you change a code there, change this too.
 * Errors that the user must fix keep their own code, so the reconnect logic does not retry them.
 */
export function classify(error: unknown, fallback: string): TransportError {
  if (error instanceof TransportError) return error;
  const raw = error instanceof Error ? error.message : String(error);
  // Nitro puts the Java class name before the message and the stack after it on Android
  // (`com.margelo.nitro.bplzlabel.a: [E_BLUETOOTH_OFF] Bluetooth is off\n  at ...`). So the code is searched in the
  // text, and the message is the rest of that line.
  const m = /\[(E_[A-Z_]+)\][ \t]*([^\r\n]*)/.exec(raw);
  if (m) return new TransportError(m[2]?.trim() || m[1] || raw, m[1]);
  return new TransportError(firstLine(raw), fallback);
}

/** The first line of a message, without a leading Java class name: the stack of a native error is not for the user. */
function firstLine(text: string): string {
  const line = (text.split(/\r?\n/)[0] ?? text).trim();
  return line.replace(/^(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*:\s+/, '') || text.trim();
}

async function wrap<T>(job: Promise<T> | T, fallback: string): Promise<T> {
  try {
    return await job;
  } catch (e) {
    throw classify(e, fallback);
  }
}

function native(): NativeBluetoothLE {
  const mod = getBluetoothLE();
  if (!mod) {
    throw new UnsupportedPlatformError(
      'The native BLE object is not available. Rebuild the app after installing the package, and do not use Expo Go.'
    );
  }
  return mod;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function toDevice(r: BleScanResult): BleDevice {
  return {
    id: r.id,
    name: r.name === '' ? null : r.name,
    rssi: r.rssi ?? null,
    connectable: r.connectable,
    serviceUuids: r.serviceUuids,
    manufacturerData: r.manufacturerData === '' ? null : r.manufacturerData,
    txPower: r.txPower ?? null,
  };
}

// ---------------------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------------------

/** Small building blocks for `BluetoothLEScanOptions.filter`. The package does not pick printers for you. */
export const bleFilters = {
  /** Name contains the text (case does not matter), or matches the RegExp. */
  name(pattern: string | RegExp): (d: BleDevice) => boolean {
    return (d) => {
      if (d.name === null) return false;
      return typeof pattern === 'string' ? d.name.toLowerCase().includes(pattern.toLowerCase()) : pattern.test(d.name);
    };
  },
  /** The advertisement lists this service. */
  serviceUuid(uuid: string): (d: BleDevice) => boolean {
    const wanted = normalize(uuid);
    return (d) => d.serviceUuids.some((s) => normalize(s) === wanted);
  },
  /** The manufacturer data starts with these hex bytes (the company id comes first, little endian). */
  manufacturerData(prefixHex: string): (d: BleDevice) => boolean {
    const wanted = prefixHex.toLowerCase();
    return (d) => d.manufacturerData?.startsWith(wanted) ?? false;
  },
  /** RSSI is at least this value (dBm). Devices without RSSI do not pass. */
  minRssi(dbm: number): (d: BleDevice) => boolean {
    return (d) => d.rssi !== null && d.rssi >= dbm;
  },
  all(...filters: Array<(d: BleDevice) => boolean>): (d: BleDevice) => boolean {
    return (d) => filters.every((f) => f(d));
  },
  any(...filters: Array<(d: BleDevice) => boolean>): (d: BleDevice) => boolean {
    return (d) => filters.some((f) => f(d));
  },
};

// ---------------------------------------------------------------------------------------
// BluetoothLE: scan and connect
// ---------------------------------------------------------------------------------------

/** An open GATT link from `BluetoothLE.connect()`. Use it to look at the GATT table. */
export class BleDeviceConnection {
  constructor(
    private readonly link: BleConnection,
    private readonly disconnectListeners: Set<(reason: string) => void>
  ) {}

  get id(): string {
    return this.link.id;
  }

  get isConnected(): boolean {
    return this.link.isConnected;
  }

  /** The agreed MTU, or an estimate on iOS (largest write without response + 3). */
  get mtu(): number {
    return this.link.mtu;
  }

  /** All services and characteristics, with their properties. */
  discover(): Promise<BleGattCharacteristic[]> {
    return wrap(this.link.discover(), 'E_DISCOVERY');
  }

  /** The GATT table as text. */
  async describe(): Promise<string> {
    return describeGatt(await this.discover());
  }

  /** Called once when the link closes, also after `disconnect()`. Returns a function that removes the listener. */
  onDisconnect(listener: (reason: string) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  disconnect(): Promise<void> {
    return wrap(this.link.disconnect(), 'E_DISCONNECTED');
  }
}

const stateListeners = new Set<(state: BleAdapterState) => void>();
let stateHooked = false;

/** Scan for and connect to Bluetooth Low Energy devices. It knows nothing about printers. */
export const BluetoothLE = {
  isSupported(): boolean {
    return getBluetoothLE() !== null;
  },

  /**
   * Ask for the runtime permissions. Android 12+: BLUETOOTH_SCAN and BLUETOOTH_CONNECT.
   * Android 11 and older: ACCESS_FINE_LOCATION (Android needs it to scan; the library does not read your location).
   * iOS: nothing to ask. iOS shows the dialog at the first scan or connect. Returns true when allowed.
   */
  async requestPermissions(): Promise<boolean> {
    if (Platform.OS !== 'android') return BluetoothLE.getState() !== 'unauthorized';
    const permissions =
      typeof Platform.Version === 'number' && Platform.Version >= 31
        ? ['android.permission.BLUETOOTH_SCAN', 'android.permission.BLUETOOTH_CONNECT']
        : ['android.permission.ACCESS_FINE_LOCATION'];
    const result = await PermissionsAndroid.requestMultiple(permissions as Parameters<typeof PermissionsAndroid.requestMultiple>[0]);
    return permissions.every((p) => (result as Record<string, string>)[p] === PermissionsAndroid.RESULTS.GRANTED);
  },

  /**
   * Show the system dialog that asks the user to turn Bluetooth on (Android: "Turn on Bluetooth?"). Resolves true when it is on,
   * false when the user said no. Ask for the permissions first (`requestPermissions()`): Android 12+ needs BLUETOOTH_CONNECT.
   * iOS has no such dialog for apps: it shows its own alert at the first use, and this resolves the current state.
   */
  async requestEnable(): Promise<boolean> {
    return wrap(native().requestEnable(), 'E_BLUETOOTH_OFF');
  },

  /** The adapter state: on, off, unauthorized, unsupported, resetting or unknown. */
  getState(): BleAdapterState {
    return native().getState() as BleAdapterState;
  },

  /** Be told when Bluetooth turns on or off, or the permission changes. Returns a function that removes the listener. */
  onStateChange(listener: (state: BleAdapterState) => void): () => void {
    const mod = native();
    stateListeners.add(listener);
    if (!stateHooked) {
      stateHooked = true;
      mod.setStateListener((s) => {
        for (const l of [...stateListeners]) l(s as BleAdapterState);
      });
    } else {
      const current = mod.getState() as BleAdapterState;
      if (current !== 'unknown') listener(current);
    }
    return () => stateListeners.delete(listener);
  },

  /**
   * Scan and return the devices found, strongest RSSI first. Rejects when the scan cannot start
   * (Bluetooth off, no permission). Does not decide what a printer is: use `filter`.
   * `stopScan()` and `signal` end the scan early. The promise then resolves with the devices found so far.
   */
  async scan(options: BluetoothLEScanOptions = {}): Promise<BleDevice[]> {
    const mod = native();
    const found = new Map<string, BleDevice>();
    const { filter, onDevice, signal } = options;
    const onAbort = () => void mod.stopScan().catch(() => undefined);
    if (signal?.aborted) return [];
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await wrap(
        mod.scan(
          {
            serviceUuids: options.serviceUuids ?? [],
            timeoutMs: options.timeoutMs ?? 5000,
            allowDuplicates: options.allowDuplicates ?? false,
          },
          (result) => {
            const device = toDevice(result);
            if (filter && !filter(device)) return;
            const isNew = !found.has(device.id);
            found.set(device.id, device);
            if (isNew) onDevice?.(device);
          }
        ),
        'E_SCAN_FAILED'
      );
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    return [...found.values()].sort((a, b) => (b.rssi ?? -Infinity) - (a.rssi ?? -Infinity));
  },

  /** End a running scan. `scan()` then resolves with what it found. */
  stopScan(): Promise<void> {
    return wrap(native().stopScan(), 'E_SCAN_FAILED');
  },

  /** Open a GATT link, for example to look at the GATT table. For printing, use `BluetoothLETransport`. */
  async connect(deviceId: string | BleDevice, options: BleConnectOptions = {}): Promise<BleDeviceConnection> {
    const listeners = new Set<(reason: string) => void>();
    const id = typeof deviceId === 'string' ? deviceId : deviceId.id;
    const link = await wrap(
      native().connect(id, options.timeoutMs ?? 10000, (reason) => {
        for (const l of [...listeners]) l(reason);
      }),
      'E_CONNECT'
    );
    return new BleDeviceConnection(link, listeners);
  },

  /** Connect, read the GATT table, disconnect. Use it to see what a device offers. */
  async inspect(deviceId: string | BleDevice, options: BleConnectOptions = {}): Promise<BleGattCharacteristic[]> {
    const connection = await BluetoothLE.connect(deviceId, options);
    try {
      return await connection.discover();
    } finally {
      await connection.disconnect().catch(() => undefined);
    }
  },

  /** The first profile whose `matches` accepts the device, or undefined. */
  matchProfile(device: BleDevice, profiles: readonly BlePrinterProfile[]): BlePrinterProfile | undefined {
    return profiles.find((p) => p.matches?.(device));
  },
};

// ---------------------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------------------

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
  private writeChain: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private lostReason: string | null = null;
  private cancelled = false;
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
      if (gen !== this.generation) throw new TransportError('The connection was closed while it opened', 'E_DISCONNECTED');
      this.link = link;
      this.connectMs = Date.now() - t0;

      const wanted = this.settings.requestMtu ?? 247;
      if (wanted !== false && Platform.OS === 'android') {
        // A refused request is fine. The link then keeps the default MTU, and the chunk size follows it.
        const active = link;
        this.mtuRequestText = await active.requestMtu(wanted).then(
          (got) => `asked ${wanted}, got ${got}`,
          (e: unknown) => `asked ${wanted}, failed: ${classify(e, 'E_TIMEOUT').message}`
        );
      }

      const t1 = Date.now();
      const table = [...(await wrap(link.discover(), 'E_DISCOVERY'))];
      if (gen !== this.generation) throw new TransportError('The connection was closed while it opened', 'E_DISCONNECTED');
      this.table = table;
      this.discoverMs = Date.now() - t1;
      this.picked = selectCharacteristics(this.table, this.settings);

      const notify = this.settings.subscribe === false ? null : this.picked.notify;
      if (notify) {
        const { serviceUuid, uuid } = notify;
        const active = link;
        try {
          await wrap(
            // A late notification of an old link must not land in the inbox of the next one.
            active.subscribe(serviceUuid, uuid, (data) => {
              if (gen === this.generation) this.inbox.push(new Uint8Array(data));
            }),
            'E_NOTIFY'
          );
          this.unsubscribe = () => active.unsubscribe(serviceUuid, uuid);
        } catch {
          // Printing works without replies. Only status queries are lost.
          this.unsubscribe = null;
        }
      }
      // The link can be lost during the steps above (the native side calls onLinkLost, which bumps nothing by itself).
      if (gen !== this.generation || !link.isConnected) {
        throw new TransportError('The connection was closed while it opened', 'E_DISCONNECTED');
      }
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

  /** Close the link and connect again. Not a retry loop: it runs once, when you call it. */
  async reconnect(): Promise<void> {
    await this.disconnect();
    await this.connect();
  }

  async disconnect(): Promise<void> {
    const link = this.link;
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
      const row: BleGattReading = { ...c };
      if (c.read) {
        try {
          row.value = new Uint8Array(await link.read(c.serviceUuid, c.uuid));
        } catch (e) {
          const error = classify(e, 'E_READ');
          row.error = { code: error.code ?? 'E_READ', message: error.message };
          // The link is gone: the rest cannot be read either.
          if (error.code === 'E_DISCONNECTED') {
            out.push(row);
            throw error;
          }
        }
      }
      out.push(row);
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
    const delay = this.settings.chunkDelayMs ?? (pick.withResponse ? 0 : 10);
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
        await this.writePiece(link, pick, piece, timeoutMs, sent, data.length);
        sent += piece.length;
        options.onProgress?.(sent, data.length);
        if (delay > 0 && index < pieces.length - 1) await sleep(delay);
      }
    } catch (e) {
      const error = classify(e, 'E_WRITE');
      // Say what went out, so the caller can tell a failure that sent nothing (safe to send again) from one that may have printed.
      error.bytesSent = sent;
      error.nothingSent = !started;
      this.lastWriteStats = stats(error);
      // The printer may hold half a job, and a native write may still be pending. Close the link,
      // so no later write can follow a failed one. The next job opens a clean link.
      await this.failLink(gen, error);
      throw error;
    }
    this.lastWriteStats = stats();
    if (gen === this.generation) this.setState('connected');
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

  private async writePiece(
    link: BleConnection,
    pick: BleSelection,
    piece: Uint8Array,
    timeoutMs: number,
    offset: number,
    total: number
  ): Promise<void> {
    // The native side has its own timeout. This one is a guard in case a native promise never settles.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new TransportError(`Write timed out after ${timeoutMs} ms (${offset} of ${total} bytes sent)`, 'E_TIMEOUT')),
        timeoutMs + 1000
      );
    });
    try {
      await Promise.race([
        wrap(link.write(pick.write.serviceUuid, pick.write.uuid, toArrayBuffer(piece), pick.withResponse, timeoutMs), 'E_WRITE'),
        guard,
      ]);
    } catch (e) {
      const error = classify(e, 'E_WRITE');
      throw new TransportError(`${error.message} (${offset} of ${total} bytes sent)`, error.code);
    } finally {
      if (timer) clearTimeout(timer);
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

function stripUndefined<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

export type { BleSelection, BleSelectionOptions, BleSelector, BleWriteMode, BleGattCharacteristic };
