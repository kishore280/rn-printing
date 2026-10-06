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
import { zplSettings } from './zpl';
import { ExtendedStatus, parseExtendedStatus, parseHostStatus, PrinterStatus } from './status';
import type { Transport } from './transport';

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

  private readonly reconnect: ResolvedReconnect;
  private readonly onEvent: (event: ConnectionEvent) => void;

  constructor(
    private readonly transport: Transport,
    options: LabelPrinterOptions = {}
  ) {
    this.reconnect = resolveReconnect(options.reconnect);
    this.onEvent = options.onConnectionEvent ?? (() => undefined);
  }

  /** Open the link (with retry) if it is closed. */
  private async ensureConnected(): Promise<void> {
    if (await this.transport.isConnected().catch(() => false)) return;
    await this.open();
  }

  private async open(): Promise<void> {
    await this.transport.disconnect().catch(() => undefined);
    await connectWithRetry(() => this.transport.connect(), this.reconnect, this.onEvent);
  }

  /**
   * Run `job` on a live link. If the link is closed, open it first.
   * If the job fails, close the link so the next job starts clean. Then:
   * - `idempotent` jobs (queries) and `E_NOT_CONNECTED` (no byte was sent) are run again once.
   * - Other write failures are NOT run again unless `resendAfterPartialWrite` is true,
   *   because part of the label may already be printing.
   */
  private async withLink<T>(job: () => Promise<T>, idempotent: boolean): Promise<T> {
    await this.ensureConnected();
    try {
      return await job();
    } catch (e) {
      await this.transport.disconnect().catch(() => undefined);
      const code = (e as { code?: string } | null)?.code;
      const safe = idempotent || code === 'E_NOT_CONNECTED' || this.reconnect.resendAfterPartialWrite;
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
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Open the link now, with retry. Optional: print() and the queries connect by themselves. */
  connect(): Promise<void> {
    return this.exclusive(() => this.open());
  }

  disconnect(): Promise<void> {
    return this.transport.disconnect();
  }

  isConnected(): Promise<boolean> {
    return this.transport.isConnected();
  }

  /** Send a label from any builder, or a raw command string. */
  print(label: Printable | string): Promise<void> {
    const bytes = typeof label === 'string' ? utf8Encode(label) : label.toBytes();
    return this.exclusive(() => this.withLink(() => this.transport.write(bytes), false));
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

  /** Send a query, wait for the reply and parse it. Nothing else is sent in between. */
  private query<T>(command: string, options: StatusOptions, parse: (raw: string) => T | null): Promise<T | null> {
    return this.exclusive(() => this.withLink(async () => {
      // Remove old bytes first, so a late reply to an earlier question is not read as this one.
      await this.transport.read({ timeoutMs: 100, idleMs: 50 });
      await this.transport.write(utf8Encode(command));
      const bytes = await this.transport.read({ timeoutMs: options.timeoutMs ?? 1500, idleMs: 150 });
      return bytes.length === 0 ? null : parse(latin1Decode(bytes));
    }, true));
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
