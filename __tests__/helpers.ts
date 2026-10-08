import type { ReadOptions, Transport } from '../src/transport';

/** A fake Transport. It records writes and answers reads from a queue. */
export class FakeTransport implements Transport {
  written: Uint8Array[] = [];
  replies: Uint8Array[] = [];
  connected = false;
  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  async isConnected() { return this.connected; }
  async write(data: Uint8Array, _options?: unknown) { this.written.push(data); }
  async read(_options?: ReadOptions): Promise<Uint8Array> { return this.replies.shift() ?? new Uint8Array(0); }
  writtenText(): string { return this.written.map((w) => Array.from(w, (b) => String.fromCharCode(b)).join('')).join('|'); }
}

export const bytes = (s: string) => Uint8Array.from(Array.from(s, (c) => c.charCodeAt(0)));
