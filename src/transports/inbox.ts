import type { ReadOptions } from '../transport';

/** The most bytes kept for a reader that never comes. A reply of a printer is a few hundred bytes. */
export const INBOX_LIMIT = 64 * 1024;

/**
 * Collects bytes that arrive from a notification or socket, and hands them out by polling. A print-only session may never read, so the
 * inbox keeps the newest `INBOX_LIMIT` bytes and drops the oldest: a chatty printer cannot make the app grow without end.
 */
export class Inbox {
  private bytes: number[] = [];

  push(chunk: ArrayLike<number>): void {
    for (let i = 0; i < chunk.length; i++) this.bytes.push(chunk[i] ?? 0);
    if (this.bytes.length > INBOX_LIMIT) this.bytes.splice(0, this.bytes.length - INBOX_LIMIT);
  }

  clear(): void {
    this.bytes = [];
  }

  get size(): number {
    return this.bytes.length;
  }

  async read(options: ReadOptions = {}): Promise<Uint8Array> {
    const timeoutMs = options.timeoutMs ?? 1500;
    const idleMs = options.idleMs ?? 150;
    const maxBytes = options.maxBytes ?? 0;
    const start = Date.now();
    let lastSize = this.bytes.length;
    let lastChange = start;

    while (Date.now() - start < timeoutMs) {
      await new Promise<void>((r) => setTimeout(r, 10));
      if (this.bytes.length !== lastSize) {
        lastSize = this.bytes.length;
        lastChange = Date.now();
      }
      if (maxBytes > 0 && this.bytes.length >= maxBytes) break;
      if (this.bytes.length > 0 && Date.now() - lastChange >= idleMs) break;
    }
    const take = maxBytes > 0 ? Math.min(maxBytes, this.bytes.length) : this.bytes.length;
    return Uint8Array.from(this.bytes.splice(0, take));
  }
}
