import { TransportError } from '../errors';
import type { LinkEvent, LinkState, ReadOptions, Transport, WriteOptions } from '../transport';
import { chunkBytes } from './chunk';
import { Inbox } from './inbox';

/**
 * The parts of a `react-native-tcp-socket` socket that we use. `on` is one overload for each event, so the library's own `Socket` type fits
 * without a cast (its `on` takes the event name and the matching argument list).
 */
export interface TcpSocketLike {
  write(data: Uint8Array | string, encoding?: string, cb?: (error?: Error | null) => void): unknown;
  on(event: 'data', listener: (chunk: string | Uint8Array) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (hadError: boolean) => void): unknown;
  destroy(): void;
  /**
   * Close after the pending writes. In `react-native-tcp-socket` 6.4.3 this is a FULL close on both platforms (Android calls `Socket.close()`,
   * iOS `disconnectAfterWriting`), not a half-close, although its JavaScript comment says "sends a FIN": nothing can be read after it.
   */
  end?(): unknown;
  /** Send each segment at once (no Nagle delay). `react-native-tcp-socket` has it on both platforms. */
  setNoDelay?(noDelay?: boolean): unknown;
}

/**
 * What ends a job.
 * - `close` (default): `endJob()` closes the connection. One job is one connection: a print server that ends a job at the close (PrinterOne
 *   on Windows prints at the close, or after 30 s of silence; `p910nd` copies until it reads end of file) prints at once, and a printer that
 *   allows one connection at a time is free for the next client. `LabelPrinter` calls `endJob()` after the last byte of a print and after
 *   the reply of a question, so a reply (`~HS`) can still be read.
 * - `none`: `endJob()` does nothing and the link stays open between jobs.
 */
export type TcpEndOfJob = 'close' | 'none';

export interface TcpTransportOptions {
  host: string;
  /** Default 9100 (raw printing port). */
  port?: number;
  /**
   * Pass `TcpSocket.createConnection` from the `react-native-tcp-socket` package.
   * It is injected so that this library has no hard dependency on it.
   */
  createConnection: (
    options: { host: string; port: number },
    onConnect: () => void
  ) => TcpSocketLike;
  /** Default 5000. */
  connectTimeoutMs?: number;
  /** Default `close`. */
  endOfJob?: TcpEndOfJob;
  /** Bytes in one write piece. Default 16384. Pieces let a long job report progress and be cancelled. */
  chunkSize?: number;
  /**
   * One piece must be done in this time, or the socket is destroyed and the write fails with E_TIMEOUT. The limit is for one piece, not the
   * whole job: a long job to a slow printer is fine while it keeps taking pieces. Default 15000.
   */
  writeTimeoutMs?: number;
  /** After `endJob()`, how long to wait for the connection to close before the socket is destroyed to free it. Default 5000. */
  closeWaitMs?: number;
}

function toBytes(chunk: string | Uint8Array): Uint8Array {
  if (typeof chunk === 'string') {
    const out = new Uint8Array(chunk.length);
    for (let i = 0; i < chunk.length; i++) out[i] = chunk.charCodeAt(i) & 0xff;
    return out;
  }
  return Uint8Array.from(chunk);
}

/**
 * Raw TCP link (port 9100) for printers with the Ethernet or WiFi option, and for print servers that forward the bytes
 * (PrinterOne on Windows, `p910nd` on a Raspberry Pi or a router). Works on Android and iOS.
 *
 * One job is one connection (`endOfJob: 'close'`, the default): `LabelPrinter` calls `endJob()` when the job is done, the connection closes,
 * and the next job opens a new one. See docs/REFERENCES.md for the sources (Linux `tcp.c`, CUPS, `p910nd`, `react-native-tcp-socket`).
 */
export class TcpTransport implements Transport {
  private socket: TcpSocketLike | null = null;
  /** The socket is open and can be written to. False after endJob, an error or a close. */
  private connected = false;
  private lastError: string | null = null;
  private state: LinkState = 'disconnected';
  private cancelled = false;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly inbox = new Inbox();
  private readonly listeners = new Set<(event: LinkEvent) => void>();

  constructor(private readonly options: TcpTransportOptions) {}

  get connectionState(): LinkState {
    return this.state;
  }

  onConnectionState(listener: (event: LinkEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setState(state: LinkState, extra: { reason?: string; error?: Error } = {}): void {
    this.state = state;
    const event: LinkEvent = { state, ...extra };
    for (const l of [...this.listeners]) l(event);
  }

  private clearCloseTimer(): void {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
  }

  /** Destroy this socket (if it is still the current one) and tell why. */
  private drop(socket: TcpSocketLike, reason: string, error?: Error): void {
    socket.destroy();
    if (this.socket !== socket) return;
    this.connected = false;
    this.clearCloseTimer();
    if (this.state !== 'disconnected') this.setState('disconnected', error ? { reason, error } : { reason });
  }

  /** Stop the write that runs now, between two pieces. The write rejects with E_CANCELLED and the connection closes. */
  cancel(): void {
    this.cancelled = true;
  }

  connect(): Promise<void> {
    const { host, createConnection } = this.options;
    const port = this.options.port ?? 9100;
    const timeoutMs = this.options.connectTimeoutMs ?? 5000;
    if (!host) return Promise.reject(new TransportError('TcpTransport needs a host', 'E_BAD_ADDRESS'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return Promise.reject(new TransportError(`Bad TCP port: ${port}`, 'E_BAD_ADDRESS'));
    }
    // A second connect() must not leave the first socket open.
    this.clearCloseTimer();
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
    this.lastError = null;
    this.cancelled = false;
    this.inbox.clear();
    this.setState('connecting');

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const err = new TransportError(`Connection to ${host}:${port} timed out`, 'E_TIMEOUT');
        if (this.socket) this.drop(this.socket, 'connect timed out', err);
        reject(err);
      }, timeoutMs);

      const socket = createConnection({ host, port }, () => {
        if (settled || this.socket !== socket) return;
        settled = true;
        clearTimeout(timer);
        // A job is a few large writes: do not let the last small segment wait for the printer's delayed ACK (Nagle, RFC 896).
        socket.setNoDelay?.(true);
        this.connected = true;
        this.setState('connected');
        resolve();
      });
      this.socket = socket;
      socket.on('data', (chunk) => {
        if (this.socket === socket) this.inbox.push(toBytes(chunk));
      });
      socket.on('error', (err: Error) => {
        if (this.socket !== socket) return;
        this.lastError = err.message || 'TCP error';
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.drop(socket, 'connect failed', new Error(this.lastError));
          reject(new TransportError(`Cannot connect to ${host}:${port}: ${this.lastError}`, 'E_CONNECT'));
          return;
        }
        this.drop(socket, 'error', new Error(this.lastError));
      });
      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.connected = false;
        this.clearCloseTimer();
        // After our own endJob the state is already 'disconnected'; a close the printer started is a lost link.
        if (this.state !== 'disconnected') this.setState('disconnected', { reason: 'closed by the printer' });
      });
    });
  }

  async disconnect(): Promise<void> {
    this.clearCloseTimer();
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
    this.inbox.clear();
    if (this.state !== 'disconnected') this.setState('disconnected', { reason: 'requested' });
  }

  async isConnected(): Promise<boolean> {
    return this.connected;
  }

  /** One piece, done or failed. Rejects with E_TIMEOUT when the piece does not finish, and E_WRITE when the socket reports an error. */
  private writePiece(socket: TcpSocketLike, piece: Uint8Array): Promise<void> {
    const timeoutMs = this.options.writeTimeoutMs ?? 15000;
    return new Promise<void>((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new TransportError(`TCP write timed out after ${timeoutMs} ms`, 'E_TIMEOUT'));
      }, timeoutMs);
      socket.write(piece, undefined, (err?: Error | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) reject(new TransportError(`TCP write failed: ${err.message}`, 'E_WRITE'));
        else resolve();
      });
    });
  }

  async write(data: Uint8Array, options: WriteOptions = {}): Promise<void> {
    const socket = this.socket;
    if (!socket || !this.connected) {
      throw new TransportError(this.lastError ? `Not connected (${this.lastError})` : 'Not connected', 'E_NOT_CONNECTED');
    }
    const pieces = chunkBytes(data, this.options.chunkSize ?? 16384);
    this.cancelled = false;
    this.setState('writing');
    let sent = 0;
    try {
      for (const piece of pieces) {
        if (this.cancelled || options.signal?.aborted) {
          throw new TransportError(`Write cancelled after ${sent} of ${data.length} bytes`, 'E_CANCELLED');
        }
        if (this.socket !== socket || !this.connected) {
          throw new TransportError(`The connection closed after ${sent} of ${data.length} bytes`, 'E_DISCONNECTED');
        }
        await this.writePiece(socket, piece);
        sent += piece.length;
        options.onProgress?.(sent, data.length);
      }
    } catch (e) {
      const error = e instanceof TransportError ? e : new TransportError(String(e), 'E_WRITE');
      // Say what went out, so the caller can tell a failure that sent nothing (safe to send again) from one that may have printed.
      error.bytesSent = sent;
      error.nothingSent = sent === 0 && error.code !== 'E_TIMEOUT' && error.code !== 'E_WRITE';
      this.drop(socket, error.code === 'E_CANCELLED' ? 'cancelled' : 'write failed', error);
      throw error;
    }
    if (this.state === 'writing') this.setState('connected');
  }

  /**
   * The job is done. With `endOfJob: 'close'` the connection is closed: `socket.end()` (after the pending writes) when the socket has it, else
   * `destroy()`. The state becomes 'disconnected' with reason 'requested', so `LabelPrinter.health` reads a close on purpose, not a lost link.
   * If the printer does not close its side within `closeWaitMs`, the socket is destroyed to free it.
   *
   * Linux `__tcp_close` (net/ipv4/tcp.c) sends RST, not FIN, when received data is still unread at the close; the RST can make the receiver throw
   * away the end of the job. `data` events are read at once into the inbox, so nothing stays unread here.
   */
  async endJob(): Promise<void> {
    const socket = this.socket;
    if ((this.options.endOfJob ?? 'close') === 'none' || !socket || !this.connected) return;
    this.connected = false;
    this.setState('disconnected', { reason: 'requested' });
    if (typeof socket.end === 'function') socket.end();
    else socket.destroy();
    this.clearCloseTimer();
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;
      if (this.socket === socket) {
        socket.destroy();
        this.socket = null;
      }
    }, this.options.closeWaitMs ?? 5000);
  }

  read(options: ReadOptions = {}): Promise<Uint8Array> {
    return this.inbox.read(options);
  }
}
