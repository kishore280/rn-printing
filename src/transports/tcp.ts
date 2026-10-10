import { TransportError } from '../errors';
import type { LinkEvent, LinkState, ReadOptions, Transport } from '../transport';
import { Inbox } from './inbox';

/** The parts of a `react-native-tcp-socket` socket that we use. */
export interface TcpSocketLike {
  write(data: Uint8Array | string, encoding?: string, cb?: (error?: Error | null) => void): unknown;
  on(event: string, listener: (...args: never[]) => void): unknown;
  destroy(): void;
  /** Half-close: send FIN and keep reading (`react-native-tcp-socket` has it). Needed for `endOfJob: 'half-close'`. */
  end?(): unknown;
}

/**
 * How one job ends on the wire.
 * - `half-close` (default): after the bytes are written, the transport sends FIN (the write side closes, the read side stays open).
 *   This is how the CUPS socket backend ends a job (`shutdown(fd, SHUT_WR)`, then it waits for the printer to finish). A printer that
 *   keeps the connection open does not need it; a print server that waits for the end of the stream does (PrinterOne on Windows waits
 *   for the close or 30 s of silence, then prints). The next job opens a new connection.
 * - `none`: the link stays open between jobs. A printer that allows only one connection at a time then refuses every other client.
 */
export type TcpEndOfJob = 'half-close' | 'none';

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
  /** Default `half-close`. */
  endOfJob?: TcpEndOfJob;
  /** One write must be done in this time, or the socket is destroyed and the write fails with E_TIMEOUT. Default 30000. */
  writeTimeoutMs?: number;
  /**
   * After the half-close, how long the transport waits for the printer to close its side (and for a reply to be read) before it
   * destroys the socket to free it. Default 5000.
   */
  closeWaitMs?: number;
}

function toBytes(chunk: unknown): Uint8Array {
  if (typeof chunk === 'string') {
    const out = new Uint8Array(chunk.length);
    for (let i = 0; i < chunk.length; i++) out[i] = chunk.charCodeAt(i) & 0xff;
    return out;
  }
  return Uint8Array.from(chunk as ArrayLike<number>);
}

/**
 * Raw TCP link (port 9100) for printers with the Ethernet or WiFi option, and for print servers that forward the bytes
 * (PrinterOne on Windows, `p910nd` on a Raspberry Pi or a router). Works on Android and iOS.
 *
 * One job is one connection (`endOfJob: 'half-close'`, the default): after a write the transport sends FIN and the link counts as closed,
 * so `LabelPrinter` opens a new connection for the next job. Replies (`~HS`) can still be read until the printer closes its side.
 */
export class TcpTransport implements Transport {
  private socket: TcpSocketLike | null = null;
  /** The socket is open and can be written to. False after the half-close, an error or a close. */
  private connected = false;
  private lastError: string | null = null;
  private state: LinkState = 'disconnected';
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
        this.connected = true;
        this.setState('connected');
        resolve();
      });
      this.socket = socket;
      socket.on('data', (chunk: unknown) => {
        if (this.socket === socket) this.inbox.push(toBytes(chunk));
      });
      socket.on('error', (err: { message?: string } | undefined) => {
        if (this.socket !== socket) return;
        this.lastError = err?.message ?? 'TCP error';
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
        // After our own half-close the state is already 'disconnected'; a close the printer started is a lost link.
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

  write(data: Uint8Array): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = this.socket;
      if (!socket || !this.connected) {
        reject(new TransportError(this.lastError ? `Not connected (${this.lastError})` : 'Not connected', 'E_NOT_CONNECTED'));
        return;
      }
      const timeoutMs = this.options.writeTimeoutMs ?? 30000;
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        const err = new TransportError(`TCP write timed out after ${timeoutMs} ms`, 'E_TIMEOUT');
        this.drop(socket, 'write timed out', err);
        reject(err);
      }, timeoutMs);
      this.setState('writing');
      socket.write(data, undefined, (err?: Error | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) {
          const failure = new TransportError(`TCP write failed: ${err.message}`, 'E_WRITE');
          this.drop(socket, 'write failed', failure);
          reject(failure);
          return;
        }
        this.endJob(socket);
        resolve();
      });
    });
  }

  /** The job is written. Half-close (FIN) so the receiver knows the job is complete, then free the socket when the printer is done. */
  private endJob(socket: TcpSocketLike): void {
    if ((this.options.endOfJob ?? 'half-close') === 'none' || typeof socket.end !== 'function') {
      this.setState('connected');
      return;
    }
    this.connected = false;
    socket.end();
    // The link is closed on purpose: LabelPrinter reads this as 'closed', not as a lost link. A reply can still be read.
    this.setState('disconnected', { reason: 'requested' });
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
