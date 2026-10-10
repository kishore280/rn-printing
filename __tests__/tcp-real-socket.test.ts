/**
 * TcpTransport against REAL TCP sockets (Node's `net`, the kernel's TCP), not a fake. `react-native-tcp-socket` imitates Node's `net.Socket`
 * (write, on, end, destroy, setNoDelay), so Node's own socket fits `TcpSocketLike`. A fake can only check what we think a socket does; this
 * checks what the kernel does: the whole job arrives, a reply can be read before the close, a stalled printer times out, a refused connect and a
 * peer that closes are reported.
 */
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { LabelPrinter } from '../src/printer';
import { TcpTransport } from '../src/transports/tcp';

jest.setTimeout(20000);

interface FakePrinter {
  port: number;
  /** Bytes received so far, in order. */
  received: () => Buffer;
  /** Resolves when a client has closed its side (end of file) and the server saw all bytes. */
  clientEnded: Promise<void>;
  close: () => Promise<void>;
  sockets: net.Socket[];
}

/** A fake printer: collects what it receives, optionally answers, optionally never reads (a stalled printer). */
function listen(options: { reply?: (data: Buffer) => string | null; stall?: boolean; closeAfterBytes?: number } = {}): Promise<FakePrinter> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const sockets: net.Socket[] = [];
    let ended!: () => void;
    const clientEnded = new Promise<void>((r) => (ended = r));
    const server = net.createServer((socket) => {
      sockets.push(socket);
      let total = 0;
      if (options.stall) socket.pause();
      socket.on('data', (d: Buffer) => {
        chunks.push(d);
        total += d.length;
        const reply = options.reply?.(Buffer.concat(chunks));
        if (reply) socket.write(reply);
        if (options.closeAfterBytes !== undefined && total >= options.closeAfterBytes) socket.destroy();
      });
      socket.on('end', () => {
        ended();
        socket.end();
      });
      socket.on('error', () => undefined);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        received: () => Buffer.concat(chunks),
        clientEnded,
        sockets,
        close: () => new Promise((r) => { sockets.forEach((s) => s.destroy()); server.close(() => r()); }),
      });
    });
  });
}

const transportFor = (port: number, extra: Partial<ConstructorParameters<typeof TcpTransport>[0]> = {}) =>
  new TcpTransport({
    host: '127.0.0.1',
    port,
    createConnection: (o, onConnect) => net.createConnection({ host: o.host, port: o.port }, onConnect),
    ...extra,
  });

describe('TcpTransport on a real socket', () => {
  it('delivers a whole job, in order, and the printer sees the end of the job when endJob() closes', async () => {
    const printer = await listen();
    const t = transportFor(printer.port);
    const job = Buffer.alloc(300_000, 0).map((_, i) => i % 251);
    await t.connect();
    await t.write(Uint8Array.from(job));
    await t.endJob();
    await printer.clientEnded;
    expect(printer.received().equals(job)).toBe(true);
    await printer.close();
  });

  it('LabelPrinter: two prints are two connections, each one ended', async () => {
    const printer = await listen();
    const lp = new LabelPrinter(transportFor(printer.port));
    await lp.printRaw(Uint8Array.of(1, 2, 3));
    await lp.printRaw(Uint8Array.of(4, 5));
    await new Promise((r) => setTimeout(r, 50));
    expect(printer.sockets).toHaveLength(2);
    expect(Array.from(printer.received())).toEqual([1, 2, 3, 4, 5]);
    await lp.dispose();
    await printer.close();
  });

  it('a question: the reply is read before the close, then the connection ends', async () => {
    const printer = await listen({ reply: (d) => (d.toString().includes('~HS') ? '\u0002030,0,0,0561\u0003' : null) });
    const lp = new LabelPrinter(transportFor(printer.port));
    const answer = await lp.ask('~HS');
    expect(answer).toContain('030,0,0,0561');
    await printer.clientEnded;
    await lp.dispose();
    await printer.close();
  });

  it('a printer that stops reading: a piece does not finish, E_TIMEOUT, and the bytes sent are told', async () => {
    const printer = await listen({ stall: true });
    // A big job fills the kernel buffers (client send buffer and server receive buffer); the stalled server never reads them.
    const t = transportFor(printer.port, { writeTimeoutMs: 300, chunkSize: 64 * 1024 });
    await t.connect();
    const error = await t.write(new Uint8Array(64 * 1024 * 1024)).then(() => null, (e: unknown) => e as { code?: string; bytesSent?: number });
    expect(error?.code).toBe('E_TIMEOUT');
    expect(error?.bytesSent ?? 0).toBeGreaterThan(0);
    expect(await t.isConnected()).toBe(false);
    await printer.close();
  });

  it('a refused connection is E_CONNECT with the address, and a closed port does not hang', async () => {
    const probe = await listen();
    const closedPort = probe.port;
    await probe.close();
    const t = transportFor(closedPort);
    await expect(t.connect()).rejects.toMatchObject({ code: 'E_CONNECT', message: expect.stringContaining(`127.0.0.1:${closedPort}`) });
  });

  it('a printer that closes in the middle of a job is an error, not a silent success', async () => {
    const printer = await listen({ closeAfterBytes: 1000 });
    const t = transportFor(printer.port, { chunkSize: 500 });
    await t.connect();
    const error = await t.write(new Uint8Array(50_000_000)).then(() => null, (e: unknown) => e as { code?: string });
    expect(error).not.toBeNull();
    expect(['E_WRITE', 'E_DISCONNECTED']).toContain(error?.code);
    await printer.close();
  });

  it('cancel() between pieces stops a long job on a real socket', async () => {
    const printer = await listen();
    const t = transportFor(printer.port, { chunkSize: 1024 });
    await t.connect();
    let calls = 0;
    const error = await t
      .write(new Uint8Array(1024 * 1024), { onProgress: () => { if (++calls === 3) t.cancel(); } })
      .then(() => null, (e: unknown) => e as { code?: string; bytesSent?: number });
    expect(error?.code).toBe('E_CANCELLED');
    expect(error?.bytesSent).toBe(3 * 1024);
    await printer.close();
  });
});
