import { TransportError } from '../errors';
import { JOB_DONE } from '../transport';
import type { LinkEvent, LinkState, ReadOptions, Transport, WriteOptions } from '../transport';
import { chunkBytes } from './chunk';
import { Inbox } from './inbox';

/**
 * The part of a `react-native-tcp-socket` socket that we use (Node's `net.Socket` fits too). `on` has one overload for each event, so the
 * library's own `Socket` type fits without a cast.
 */
export interface TcpSocketLike {
  write(data: Uint8Array | string, encoding?: string, cb?: (error?: Error | null) => void): unknown;
  on(event: 'data', listener: (chunk: string | Uint8Array) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (hadError: boolean) => void): unknown;
  destroy(): void;
  /** Send each segment at once, without the Nagle delay. */
  setNoDelay?(noDelay?: boolean): unknown;
}

export interface TcpTransportOptions {
  host: string;
  /** Default 9100, the raw printing port. */
  port?: number;
  /** Pass `TcpSocket.createConnection` of `react-native-tcp-socket`: this package has no hard dependency on it. */
  createConnection: (options: { host: string; port: number }, onConnect: () => void) => TcpSocketLike;
  /** Default 5000. */
  connectTimeoutMs?: number;
  /** Bytes in one write piece. Default 16384. */
  chunkSize?: number;
  /** One piece must finish in this time, or the write fails with E_TIMEOUT. The limit is for a piece, not the job. Default 15000. */
  writeTimeoutMs?: number;
}

/** One connect(): it ends exactly once, whoever comes first: the socket, the timer or a newer connect. */
class Attempt {
  settled = false;
  timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly resolve: () => void,
    readonly reject: (error: TransportError) => void,
  ) {}

  /** True for the first call only; it also stops the timer. */
  settle(): boolean {
    if (this.settled) return false;
    this.settled = true;
    clearTimeout(this.timer);
    return true;
  }
}

function toBytes(chunk: string | Uint8Array): Uint8Array {
  if (typeof chunk === 'string') return Uint8Array.from(chunk, (c) => c.charCodeAt(0) & 0xff);
  return Uint8Array.from(chunk);
}

/**
 * Raw TCP link (port 9100) to a printer with a network card, or to a print server that forwards the bytes (PrinterOne, `p910nd`).
 *
 * One job is one connection. A print server ends a job at the close of the connection, and a printer that takes one connection at a time is
 * free again only after it. `LabelPrinter` calls `endJob()` after the last byte of a print and after the reply of a question, so a reply can
 * be read before the close. Sources: docs/REFERENCES.md ("TCP link").
 */
export class TcpTransport implements Transport {
  private socket: TcpSocketLike | null = null;
  private connected = false;
  private lastError: string | null = null;
  private state: LinkState = 'disconnected';
  private cancelled = false;
  /** Ends the connect that is still waiting (a new connect or a disconnect came first). */
  private abandonConnect: (() => void) | null = null;
  /** Fails the piece that is being written, when the socket closes or breaks under it. */
  private failPiece: ((error: TransportError) => void) | null = null;
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
    for (const listener of [...this.listeners]) listener({ state, ...extra });
  }

  /** Destroy this socket and, if it is still the current one, say why the link ended. */
  private drop(socket: TcpSocketLike, reason: string, error?: Error): void {
    socket.destroy();
    if (this.socket !== socket) return;
    this.connected = false;
    if (this.state !== 'disconnected') this.setState('disconnected', error ? { reason, error } : { reason });
  }

  /** Stop the write that runs now, between two pieces: it rejects with E_CANCELLED and the connection closes. */
  cancel(): void {
    this.cancelled = true;
  }

  /** The address is the caller's to fix, so a bad one is not retried (E_BAD_ADDRESS). */
  private addressProblem(): TransportError | null {
    const port = this.options.port ?? 9100;
    if (!this.options.host) return new TransportError('TcpTransport needs a host', 'E_BAD_ADDRESS');
    if (!Number.isInteger(port) || port < 1 || port > 65535) return new TransportError(`Bad TCP port: ${port}`, 'E_BAD_ADDRESS');
    return null;
  }

  connect(): Promise<void> {
    const problem = this.addressProblem();
    if (problem) return Promise.reject(problem);
    // A second connect() must not leave the first socket open, nor its promise waiting for its timer.
    this.abandonConnect?.();
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
    this.lastError = null;
    this.cancelled = false;
    this.inbox.clear();
    this.setState('connecting');
    return new Promise<void>((resolve, reject) => this.open(new Attempt(resolve, reject)));
  }

  /** Open the socket for one connect attempt. The attempt settles once: connected, failed, timed out or abandoned. */
  private open(attempt: Attempt): void {
    const { host, createConnection } = this.options;
    const port = this.options.port ?? 9100;
    const timeoutMs = this.options.connectTimeoutMs ?? 5000;
    const socket = createConnection({ host, port }, () => {
      if (this.socket !== socket || !attempt.settle()) return;
      this.abandonConnect = null;
      // A job is a few large writes: the last small segment must not wait for the printer's delayed ACK (Nagle, RFC 896).
      socket.setNoDelay?.(true);
      this.connected = true;
      this.setState('connected');
      attempt.resolve();
    });
    this.socket = socket;
    attempt.timer = setTimeout(() => {
      if (!attempt.settle()) return;
      this.abandonConnect = null;
      const error = new TransportError(`Connection to ${host}:${port} timed out`, 'E_TIMEOUT');
      // This attempt's own socket only: a newer connect may own the link by now.
      this.drop(socket, 'connect timed out', error);
      attempt.reject(error);
    }, timeoutMs);
    this.abandonConnect = () => {
      if (!attempt.settle()) return;
      this.abandonConnect = null;
      attempt.reject(new TransportError('The connection was cancelled', 'E_CANCELLED'));
    };
    this.watch(socket, attempt);
  }

  /** The socket's own events: the printer's bytes, an error, a close. Events of a socket that is no longer the current one are ignored. */
  private watch(socket: TcpSocketLike, attempt: Attempt): void {
    const { host } = this.options;
    const port = this.options.port ?? 9100;
    socket.on('data', (chunk) => {
      if (this.socket === socket) this.inbox.push(toBytes(chunk));
    });
    socket.on('error', (error: Error) => {
      if (this.socket !== socket) return;
      this.lastError = error.message || 'TCP error';
      if (attempt.settled) return this.socketBroke(socket, new Error(this.lastError));
      attempt.settle();
      this.abandonConnect = null;
      this.drop(socket, 'connect failed', new Error(this.lastError));
      attempt.reject(new TransportError(`Cannot connect to ${host}:${port}: ${this.lastError}`, 'E_CONNECT'));
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.connected = false;
      // A write in flight fails now and reports the loss itself; a close after our own endJob() finds the state already 'disconnected'.
      if (this.failPiece) this.failPiece(new TransportError('TCP write failed: the connection closed', 'E_WRITE'));
      else if (this.state !== 'disconnected') this.setState('disconnected', { reason: 'closed by the printer' });
    });
  }

  /** The socket failed after it connected: it ends a write in flight, else it is a lost link. */
  private socketBroke(socket: TcpSocketLike, error: Error): void {
    if (this.failPiece) {
      this.connected = false;
      this.failPiece(new TransportError(`TCP write failed: ${error.message}`, 'E_WRITE'));
      return;
    }
    this.drop(socket, 'error', error);
  }

  async disconnect(): Promise<void> {
    this.abandonConnect?.();
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
    this.inbox.clear();
    if (this.state !== 'disconnected') this.setState('disconnected', { reason: 'requested' });
  }

  async isConnected(): Promise<boolean> {
    return this.connected;
  }

  /** One piece, written or failed: E_TIMEOUT when it does not finish, E_WRITE when the socket reports an error or closes. */
  private writePiece(socket: TcpSocketLike, piece: Uint8Array): Promise<void> {
    const timeoutMs = this.options.writeTimeoutMs ?? 15000;
    return new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (error?: TransportError): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.failPiece = null;
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => finish(new TransportError(`TCP write timed out after ${timeoutMs} ms`, 'E_TIMEOUT')), timeoutMs);
      this.failPiece = finish;
      socket.write(piece, undefined, (error?: Error | null) => {
        finish(error ? new TransportError(`TCP write failed: ${error.message}`, 'E_WRITE') : undefined);
      });
    });
  }

  async write(data: Uint8Array, options: WriteOptions = {}): Promise<void> {
    const socket = this.socket;
    if (!socket || !this.connected) {
      throw new TransportError(this.lastError ? `Not connected (${this.lastError})` : 'Not connected', 'E_NOT_CONNECTED');
    }
    this.cancelled = false;
    this.setState('writing');
    let sent = 0;
    try {
      for (const piece of chunkBytes(data, this.options.chunkSize ?? 16384)) {
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
      error.bytesSent = sent;
      // Only a failure before the first piece can be sure that nothing went out; a piece that failed may have gone out in part.
      error.nothingSent = sent === 0 && error.code !== 'E_TIMEOUT' && error.code !== 'E_WRITE';
      this.drop(socket, error.code === 'E_CANCELLED' ? 'cancelled' : 'write failed', error);
      throw error;
    }
    this.setState('connected');
  }

  /**
   * The job is done: close the connection. Every piece was handed to the kernel (the write callback), and the receive queue is empty because
   * `data` events are read at once, which matters: Linux answers a close with unread data by RST, not FIN (`__tcp_close`), and the printer may
   * drop the end of the job. The link ends with `JOB_DONE`, so `LabelPrinter.health` keeps what the last job showed: a close after a good job
   * is not a lost link, and it does not hide a printer that stopped answering.
   */
  async endJob(): Promise<void> {
    const socket = this.socket;
    if (!socket || !this.connected) return;
    this.connected = false;
    this.setState('disconnected', { reason: JOB_DONE });
    socket.destroy();
  }

  read(options: ReadOptions = {}): Promise<Uint8Array> {
    return this.inbox.read(options);
  }
}
