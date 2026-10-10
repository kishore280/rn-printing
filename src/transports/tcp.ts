import { TransportError } from '../errors';
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

  connect(): Promise<void> {
    const { host, createConnection } = this.options;
    const port = this.options.port ?? 9100;
    const timeoutMs = this.options.connectTimeoutMs ?? 5000;
    if (!host) return Promise.reject(new TransportError('TcpTransport needs a host', 'E_BAD_ADDRESS'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return Promise.reject(new TransportError(`Bad TCP port: ${port}`, 'E_BAD_ADDRESS'));
    }
    // A second connect() must not leave the first socket open.
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
        const error = new TransportError(`Connection to ${host}:${port} timed out`, 'E_TIMEOUT');
        if (this.socket) this.drop(this.socket, 'connect timed out', error);
        reject(error);
      }, timeoutMs);

      const socket = createConnection({ host, port }, () => {
        if (settled || this.socket !== socket) return;
        settled = true;
        clearTimeout(timer);
        // A job is a few large writes: the last small segment must not wait for the printer's delayed ACK (Nagle, RFC 896).
        socket.setNoDelay?.(true);
        this.connected = true;
        this.setState('connected');
        resolve();
      });
      this.socket = socket;
      socket.on('data', (chunk) => {
        if (this.socket === socket) this.inbox.push(toBytes(chunk));
      });
      socket.on('error', (error: Error) => {
        if (this.socket !== socket) return;
        this.lastError = error.message || 'TCP error';
        if (settled) return this.drop(socket, 'error', new Error(this.lastError));
        settled = true;
        clearTimeout(timer);
        this.drop(socket, 'connect failed', new Error(this.lastError));
        reject(new TransportError(`Cannot connect to ${host}:${port}: ${this.lastError}`, 'E_CONNECT'));
      });
      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.connected = false;
        // A close after our own endJob() finds the state already 'disconnected'; any other close is a lost link.
        if (this.state !== 'disconnected') this.setState('disconnected', { reason: 'closed by the printer' });
      });
    });
  }

  async disconnect(): Promise<void> {
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
    this.inbox.clear();
    if (this.state !== 'disconnected') this.setState('disconnected', { reason: 'requested' });
  }

  async isConnected(): Promise<boolean> {
    return this.connected;
  }

  /** One piece, written or failed: E_TIMEOUT when it does not finish, E_WRITE when the socket reports an error. */
  private writePiece(socket: TcpSocketLike, piece: Uint8Array): Promise<void> {
    const timeoutMs = this.options.writeTimeoutMs ?? 15000;
    return new Promise<void>((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new TransportError(`TCP write timed out after ${timeoutMs} ms`, 'E_TIMEOUT'));
      }, timeoutMs);
      socket.write(piece, undefined, (error?: Error | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error) reject(new TransportError(`TCP write failed: ${error.message}`, 'E_WRITE'));
        else resolve();
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
   * The job is done: close the connection. Every write was acknowledged, so nothing is lost; and the receive queue is empty because `data`
   * events are read at once, which matters: Linux answers a close with unread data by RST, not FIN (`__tcp_close`), and the printer may drop the end of the job.
   * The link ends 'requested', so `LabelPrinter.health` reads a close on purpose, not a lost link.
   */
  async endJob(): Promise<void> {
    const socket = this.socket;
    if (!socket || !this.connected) return;
    this.connected = false;
    this.setState('disconnected', { reason: 'requested' });
    socket.destroy();
  }

  read(options: ReadOptions = {}): Promise<Uint8Array> {
    return this.inbox.read(options);
  }
}
