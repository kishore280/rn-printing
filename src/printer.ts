import { latin1Decode, utf8Encode } from './encoding';
import { PrinterNotReadyError } from './errors';
import {
  ConnectionEvent,
  connectWithRetry,
  isTransient,
  ReconnectOptions,
  resolveReconnect,
  ResolvedReconnect,
} from './reconnect';
import { settle, settleDelay, observe, HEALTH_START, type Evidence, type HealthState, type LinkHealth } from './linkHealth';
import { zplSettings } from './zpl';
import { ExtendedStatus, parseExtendedStatus, parseHostIdentification, parseHostStatus, PrinterIdentity, PrinterStatus } from './status';
import { TransportError } from './errors';
import { JOB_DONE } from './transport';
import type { LinkEvent, LinkState, Transport, WriteOptions } from './transport';
import type { BleGattReading, BluetoothLETransport } from './transports/bluetoothLE';

/** Any label builder: ZplLabel, CpclLabel or BplaLabel. */
export interface Printable {
  toBytes(): Uint8Array;
}

export interface LabelPrinterOptions {
  /**
   * Reconnect settings. true (the default) uses the defaults. false turns retry off
   * (one attempt). The printer connects by itself before a job if the link is closed.
   */
  reconnect?: ReconnectOptions | boolean | undefined;
  /** Called for every connect attempt, retry, success and failure. Use it to update the screen. */
  onConnectionEvent?: ((event: ConnectionEvent) => void) | undefined;
}

export interface WaitForPrinterOptions {
  /** Give up waiting after this many ms and send anyway. Default 15000. */
  timeoutMs?: number;
  /** Ask again after this many ms. Default 150. */
  pollMs?: number;
  /** Send the next label when the printer holds at most this many formats. Default 0. */
  maxFormatsInBuffer?: number;
}

export interface PrintAllOptions {
  /** Wait this long after each label before the next one, in ms. Default 0. */
  pauseMs?: number | undefined;
  /** Ask the printer (~HS) before each label after the first, and wait until it has room. */
  waitForPrinter?: boolean | WaitForPrinterOptions | undefined;
  /** Called after each label was sent. */
  onLabelSent?: ((index: number, total: number) => void) | undefined;
}

export interface StatusOptions {
  /** Default 1500. */
  timeoutMs?: number;
}

/** Sends labels (BPLZ, BPLC or BPLA) to a printer through a Transport. */
export class LabelPrinter {
  private queue: Promise<unknown> = Promise.resolve();
  /** Jobs that run or wait in the queue (see `busy`). */
  private pending = 0;

  private readonly reconnect: ResolvedReconnect;
  private readonly onEvent: (event: ConnectionEvent) => void;
  private healthState: HealthState = HEALTH_START;
  private healthTimer: ReturnType<typeof setTimeout> | null = null;
  /** `dispose()` was called: this printer must never open its link again (a connect that is still retrying stops at its next try). */
  private disposed = false;
  private readonly healthListeners = new Set<(health: LinkHealth) => void>();
  private readonly stopLinkEvents: () => void;

  constructor(
    private readonly transport: Transport,
    options: LabelPrinterOptions = {}
  ) {
    this.reconnect = resolveReconnect(options.reconnect);
    const user = options.onConnectionEvent ?? (() => undefined);
    this.onEvent = (e) => {
      if (e.type === 'connected') this.feed({ kind: 'alive' });
      else if (e.type === 'failed') this.feed({ kind: 'failed' });
      user(e);
    };
    // The transport tells when the link opens, closes or is lost. A failed write ends in `disconnected` with an error.
    this.stopLinkEvents =
      transport.onConnectionState?.((e) => {
        if (e.state === 'connected') this.feed({ kind: 'alive' });
        else if (e.state === 'disconnected') {
          // A close after a finished job says nothing about the link: the health stays as the last job left it.
          if (e.reason === JOB_DONE) return;
          if (e.reason === 'requested') this.feed({ kind: 'closed' });
          else this.feed({ kind: e.error ? 'failed' : 'down' });
        }
      }) ?? (() => undefined);
  }

  /** Feed the link-health rules (linkHealth.ts) and run their timer. */
  private feed(evidence: Evidence): void {
    const before = this.healthState.health;
    this.healthState = observe(this.healthState, evidence, Date.now());
    this.armHealthTimer();
    if (this.healthState.health !== before) this.emitHealth();
  }

  private armHealthTimer(): void {
    if (this.healthTimer) clearTimeout(this.healthTimer);
    this.healthTimer = null;
    const delay = settleDelay(this.healthState, Date.now());
    if (delay === null) return;
    this.healthTimer = setTimeout(() => {
      this.healthTimer = null;
      const before = this.healthState.health;
      this.healthState = settle(this.healthState, Date.now());
      if (this.healthState.health !== before) this.emitHealth();
    }, delay);
  }

  private emitHealth(): void {
    for (const l of [...this.healthListeners]) l(this.healthState.health);
  }

  /**
   * Is the link really lost? `up`, `wobbling` (down, not sure yet), `lost` (down for 4 s, or two hard failures in a row), or `unknown`
   * (no link yet, or closed on purpose). One link event never turns `up` into `lost`: see linkHealth.ts for the rules and sources.
   * This is the link only. A printer that is connected but does not answer `~HS` stays `up`: `getStatus()` returns null for it.
   */
  get health(): LinkHealth {
    return this.healthState.health;
  }

  /** Be told when `health` changes. Returns a function that removes the listener. */
  onHealth(listener: (health: LinkHealth) => void): () => void {
    this.healthListeners.add(listener);
    return () => this.healthListeners.delete(listener);
  }

  /** Close the link and stop the printer's timers and listeners. Call it when the printer object is thrown away. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.stopLinkEvents();
    if (this.healthTimer) clearTimeout(this.healthTimer);
    this.healthTimer = null;
    this.healthListeners.clear();
    await this.transport.disconnect().catch(() => undefined);
  }

  /** Open the link (with retry) if it is closed. */
  private async ensureConnected(attempts?: number): Promise<void> {
    this.assertNotDisposed();
    if (await this.transport.isConnected().catch(() => false)) return;
    await this.open(attempts);
  }

  /**
   * A printer that was disposed stays closed. Without this, a connect that was still retrying (the printer busy, out of range) opened the link
   * AFTER the app removed the printer: it stayed connected, did not advertise, and a new search could not find it. `E_CANCELLED` is not
   * transient, so the retry loop stops at once.
   */
  private assertNotDisposed(): void {
    if (this.disposed) throw new TransportError('The printer was closed', 'E_CANCELLED');
  }

  private async open(attempts?: number): Promise<void> {
    await this.transport.disconnect().catch(() => undefined);
    // A caller can ask for fewer tries than the printer's policy (never more): a status poll must not wait out a long retry.
    const policy =
      attempts === undefined ? this.reconnect : { ...this.reconnect, maxAttempts: Math.min(this.reconnect.maxAttempts, Math.max(1, attempts)) };
    await connectWithRetry(
      () => {
        this.assertNotDisposed();
        return this.transport.connect();
      },
      policy,
      this.onEvent
    );
  }

  /**
   * Run `job` on a live link. If the link is closed, open it first.
   * If the job fails, close the link so the next job starts clean. Then:
   * - `idempotent` jobs (queries) and `E_NOT_CONNECTED` (no byte was sent) are run again once.
   * - Other write failures are NOT run again unless `resendAfterPartialWrite` is true,
   *   because part of the label may already be printing.
   */
  private async withLink<T>(job: () => Promise<T>, idempotent: boolean): Promise<T> {
    try {
      await this.ensureConnected();
    } catch (e) {
      // The job never began: no byte went out, so a caller may say "nothing was printed".
      if (e !== null && typeof e === 'object') (e as { nothingSent?: boolean }).nothingSent = true;
      throw e;
    }
    try {
      return await job();
    } catch (e) {
      await this.transport.disconnect().catch(() => undefined);
      const code = (e as { code?: string } | null)?.code;
      // A write that failed before any native write began (a dead link seen at the first piece) cannot have printed: safe to send again.
      const nothingSent = (e as { nothingSent?: boolean } | null)?.nothingSent === true;
      const safe = idempotent || code === 'E_NOT_CONNECTED' || nothingSent || this.reconnect.resendAfterPartialWrite;
      if (!safe || this.reconnect.maxAttempts < 2 || !isTransient(e)) throw e;
      await this.open();
      return job();
    }
  }

  /**
   * Run one job at a time. Without this, two print() calls (or a print and a status
   * query) could mix their bytes on a link that writes in several pieces, like BLE.
   */
  private exclusive<T>(job: () => Promise<T>): Promise<T> {
    this.pending++;
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run.finally(() => {
      this.pending--;
    });
  }

  /** Tell the transport that the job is done (a TCP link closes its connection). Never fails the job that was sent. */
  private async endJob(): Promise<void> {
    await this.transport.endJob?.().catch(() => undefined);
  }

  /**
   * Open the link now, with retry, unless it is open already. Optional: print() and the queries connect by themselves.
   * An open link is left alone: a status check that closed and opened it again (as this method did before 0.4.3) dropped the data of a
   * job that was still draining (a close drops what is not sent: Linux `rfcomm_sock_destruct`), freed the printer's one connection for another
   * phone at every check, and paid a full connect each time.
   */
  connect(options?: { attempts?: number }): Promise<void> {
    return this.exclusive(() => this.ensureConnected(options?.attempts));
  }

  /** A job is running or waiting. A status check can skip a printer that is busy (it would open a second connection to a printer that takes one). */
  get busy(): boolean {
    return this.pending > 0;
  }

  /** Close the link and open it again, even when it is open (for a link that looks open and is not). */
  reopen(): Promise<void> {
    return this.exclusive(() => this.open());
  }

  /**
   * Close the link when the printer has nothing to do: after the job that is running, and after the jobs that wait. A printer that takes one
   * connection is free for another phone then. `disconnect()` closes at once, in the middle of a job; this does not. The next job connects again.
   */
  release(): Promise<void> {
    return this.exclusive(() => this.transport.disconnect());
  }

  disconnect(): Promise<void> {
    return this.transport.disconnect();
  }

  isConnected(): Promise<boolean> {
    return this.transport.isConnected();
  }

  /**
   * The state of the link now. `null` when the transport cannot tell (Classic Bluetooth, TCP). A screen reads this and
   * `onConnectionState` instead of keeping its own reference to the transport. This is the link only: the printer's own
   * state (paper out, head open) comes from `getStatus()`, and a silent printer is not a lost link.
   */
  get connectionState(): LinkState | null {
    return this.transport.connectionState ?? null;
  }

  /**
   * Be told when the link changes (connect, write, lost link, close). Returns a function that removes the listener.
   * Returns a function that does nothing when the transport has no events. These are raw events: one `disconnected` can be a
   * wobble. To show "not connected" to a person, use `health` and `onHealth`.
   */
  onConnectionState(listener: (event: LinkEvent) => void): () => void {
    return this.transport.onConnectionState?.(listener) ?? (() => undefined);
  }

  /** Stop the write that runs now, between two pieces. Does nothing when the transport cannot. */
  cancel(): void {
    this.transport.cancel?.();
  }

  /**
   * Send a label from any builder, or a raw command string.
   * `signal` stops it: before it starts (while it waits in the queue) or between two pieces of a long write (E_CANCELLED).
   * `onProgress` is told after each piece, on a transport that sends in pieces.
   */
  print(label: Printable | string, options: WriteOptions = {}): Promise<void> {
    return this.printRaw(typeof label === 'string' ? utf8Encode(label) : label.toBytes(), options);
  }

  /**
   * Send raw bytes, for example ESC/POS from `receiptToBytes`. It uses the same queue, link and reconnect rules as `print`
   * (one job at a time; no resend after a failed write unless `resendAfterPartialWrite` is set). `print` calls this method.
   */
  printRaw(bytes: Uint8Array, options: WriteOptions = {}): Promise<void> {
    return this.exclusive(() => {
      // Cancelled while it waited in the queue: do not even connect.
      if (options.signal?.aborted) throw new TransportError('The print was cancelled before it started', 'E_CANCELLED');
      return this.withLink(async () => {
        await this.transport.write(bytes, options);
        await this.endJob();
      }, false);
    });
  }

  /**
   * Send many labels in order. Stops at the first error.
   *
   * A printer that is busy printing can drop what it is sent: on one TVS LP 46 Dlite, 10 small labels sent in 53 ms printed 2.
   * So between two labels this can wait (`pauseMs`) or ask the printer (`~HS`) until it has room (`waitForPrinter`).
   * Both are NOT yet shown to fix it on a printer: that is what the hardware test is for.
   */
  async printAll(labels: ReadonlyArray<Printable | string>, options: PrintAllOptions = {}): Promise<void> {
    const wait = options.waitForPrinter === true ? {} : options.waitForPrinter || null;
    for (const [index, label] of labels.entries()) {
      if (index > 0) {
        if (options.pauseMs && options.pauseMs > 0) await new Promise<void>((r) => setTimeout(r, options.pauseMs));
        if (wait) await this.waitForRoom(wait);
      }
      await this.print(label);
      options.onLabelSent?.(index, labels.length);
    }
  }

  /**
   * Ask the printer (~HS) until it holds at most `maxFormatsInBuffer` formats and its buffer is not full, or `timeoutMs` pass.
   * Returns true when it had room, false on a timeout. A printer that does not answer ~HS counts as "no information":
   * this returns false at once, and the caller falls back to a pause.
   */
  private async waitForRoom(o: WaitForPrinterOptions): Promise<boolean> {
    const timeoutMs = o.timeoutMs ?? 15000;
    const pollMs = o.pollMs ?? 150;
    const max = o.maxFormatsInBuffer ?? 0;
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const status = await this.getStatus({ timeoutMs: 600 });
      if (status === null) return false;
      if (!status.bufferFull && status.formatsInBuffer <= max) return true;
      await new Promise<void>((r) => setTimeout(r, pollMs));
    }
    return false;
  }

  /**
   * Printer control. Each sends one ZPL command (`zplSettings`). NOT yet checked on the SNBC printer: send them and read the status.
   * `clearJobs` is ~JA (cancel all formats and clear the buffers), `resume` is ~PS (print start after a pause),
   * `reset` is ~JR (like a power cycle), `calibrate` is ~JC (measure the media; the printer feeds labels).
   */
  clearJobs(): Promise<void> {
    return this.print(zplSettings.cancelAll());
  }
  resume(): Promise<void> {
    return this.print(zplSettings.resume());
  }
  reset(): Promise<void> {
    return this.print(zplSettings.reset());
  }
  calibrate(): Promise<void> {
    return this.print(zplSettings.calibrate());
  }

  /**
   * Ask the printer for its status (~HS). Returns null when the printer gives no
   * reply, or a reply this library cannot read. Some printers do not answer.
   */
  getStatus(options: StatusOptions = {}): Promise<PrinterStatus | null> {
    return this.query('~HS', options, parseHostStatus);
  }

  /**
   * Send a read-only command and return the printer's answer as text, or null when it says nothing within `timeoutMs`.
   * For commands this library has no parser for (see `PROBES`). Only send commands that read: nothing here checks that.
   */
  ask(command: string, options: StatusOptions = {}): Promise<string | null> {
    return this.query(command, options, (raw) => raw);
  }

  /**
   * Read every readable GATT characteristic of a Bluetooth Low Energy link (the table nRF Connect shows). Resolves with null
   * for a transport that is not BLE (Classic and TCP have no GATT table). Nothing is written to the printer.
   */
  readGatt(): Promise<BleGattReading[] | null> {
    return this.exclusive(() =>
      this.withLink(async () => {
        const t = this.transport as Partial<Pick<BluetoothLETransport, 'readGatt'>>;
        return typeof t.readGatt === 'function' ? t.readGatt() : null;
      }, true)
    );
  }

  /** Send a query, wait for the reply and parse it. Nothing else is sent in between. */
  private query<T>(command: string, options: StatusOptions, parse: (raw: string) => T | null): Promise<T | null> {
    return this.exclusive(() => this.withLink(async () => {
      // Remove old bytes first, so a late reply to an earlier question is not read as this one.
      await this.transport.read({ timeoutMs: 100, idleMs: 50 });
      await this.transport.write(utf8Encode(command));
      const bytes = await this.transport.read({ timeoutMs: options.timeoutMs ?? 1500, idleMs: 150 });
      await this.endJob();
      return bytes.length === 0 ? null : parse(latin1Decode(bytes));
    }, true));
  }

  /**
   * Ask who the printer is (~HI): model, firmware and the dots per millimetre (its resolution). Returns null when it gives no reply
   * or a reply of another shape. The label length (not the width) is in the status: `getStatus().labelLengthDots`.
   */
  getIdentification(options: StatusOptions = {}): Promise<PrinterIdentity | null> {
    return this.query('~HI', options, parseHostIdentification);
  }

  /** Ask for the error and warning flags (~HQES, BPLZ only). Returns null when there is no readable reply. */
  getExtendedStatus(options: StatusOptions = {}): Promise<ExtendedStatus | null> {
    return this.query('~HQES', options, parseExtendedStatus);
  }

  /** Throws PrinterNotReadyError when the status shows paper out, head open, ribbon out or pause. */
  async assertReady(options: StatusOptions = {}): Promise<PrinterStatus | null> {
    const status = await this.getStatus(options);
    if (status && !status.ready) {
      const reasons: string[] = [];
      if (status.paperOut) reasons.push('paper out');
      if (status.headOpen) reasons.push('print head open');
      if (status.ribbonOut) reasons.push('ribbon out');
      if (status.paused) reasons.push('paused');
      throw new PrinterNotReadyError(reasons);
    }
    return status;
  }
}
