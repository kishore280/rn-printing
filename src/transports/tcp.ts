import { TransportError } from '../errors';
import type { ReadOptions, Transport } from '../transport';
import { Inbox } from './inbox';

/** The parts of a `react-native-tcp-socket` socket that we use. */
export interface TcpSocketLike {
  write(data: Uint8Array | string, encoding?: string, cb?: (error?: Error | null) => void): unknown;
  on(event: string, listener: (...args: never[]) => void): unknown;
  destroy(): void;
}

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
 * Raw TCP link (port 9100) for printers with the Ethernet or WiFi option.
 * Works on Android and iOS.
 */
export class TcpTransport implements Transport {
  private socket: TcpSocketLike | null = null;
  private connected = false;
  private readonly inbox = new Inbox();

  constructor(private readonly options: TcpTransportOptions) {}

  connect(): Promise<void> {
    const { host, createConnection } = this.options;
    const port = this.options.port ?? 9100;
    const timeoutMs = this.options.connectTimeoutMs ?? 5000;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.socket?.destroy();
        reject(new TransportError(`Connection to ${host}:${port} timed out`, 'E_TIMEOUT'));
      }, timeoutMs);

      const socket = createConnection({ host, port }, () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.connected = true;
        resolve();
      });
      this.socket = socket;
      socket.on('data', (chunk: unknown) => {
        this.inbox.push(toBytes(chunk));
      });
      socket.on('error', (err: { message?: string } | undefined) => {
        this.connected = false;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new TransportError(err?.message ?? 'TCP error', 'E_CONNECT'));
        }
      });
      socket.on('close', () => {
        this.connected = false;
      });
    });
  }

  async disconnect(): Promise<void> {
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
    this.inbox.clear();
  }

  async isConnected(): Promise<boolean> {
    return this.connected;
  }

  write(data: Uint8Array): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new TransportError('Not connected', 'E_NOT_CONNECTED'));
        return;
      }
      this.socket.write(data, undefined, (err?: Error | null) =>
        err ? reject(new TransportError(err.message, 'E_WRITE')) : resolve()
      );
    });
  }

  read(options: ReadOptions = {}): Promise<Uint8Array> {
    return this.inbox.read(options);
  }
}
