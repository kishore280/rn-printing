import { LabelPrinter } from '../src/printer';
import { TcpTransport, type TcpSocketLike } from '../src/transports/tcp';
import type { LinkEvent } from '../src/transport';

type Handler = (...a: never[]) => void;

/** A fake `react-native-tcp-socket` socket that records what happens to it. */
function fakeSocket(options: { hangWrites?: boolean; noNoDelay?: boolean; failWriteAt?: number } = {}) {
  const handlers: Record<string, Handler> = {};
  const log: string[] = [];
  const sent: number[][] = [];
  const socket: TcpSocketLike = {
    write: (data, _enc, cb) => {
      sent.push(Array.from(data as Uint8Array));
      log.push('write');
      if (options.failWriteAt !== undefined && sent.length === options.failWriteAt) cb?.(new Error('EPIPE'));
      else if (!options.hangWrites) cb?.(null);
    },
    on: (event: string, l: Handler) => { handlers[event] = l; return socket; },
    destroy: () => { log.push('destroy'); },
    ...(options.noNoDelay ? {} : { setNoDelay: () => { log.push('nodelay'); } }),
  } as TcpSocketLike;
  const emit = (event: string, ...args: unknown[]) => (handlers[event] as unknown as (...a: unknown[]) => void)?.(...args);
  return { socket, log, sent, emit };
}

/** A transport that hands out one fake socket per connection. */
function transportOf(options: Partial<ConstructorParameters<typeof TcpTransport>[0]> = {}, socketOptions = {}) {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const t = new TcpTransport({
    host: 'h',
    createConnection: (_o, onConnect) => {
      const f = fakeSocket(socketOptions);
      sockets.push(f);
      setTimeout(onConnect, 0);
      return f.socket;
    },
    ...options,
  });
  return { t, sockets };
}

describe('TcpTransport: one job is one connection', () => {
  it('a write does not close the connection: the reply of a question must still be readable', async () => {
    const { t, sockets } = transportOf();
    await t.connect();
    await t.write(Uint8Array.of(1, 2, 3));
    expect(await t.isConnected()).toBe(true);
    expect(sockets[0]!.log).not.toContain('destroy');
  });

  it('endJob closes the connection, and the next job needs a new one', async () => {
    const { t, sockets } = transportOf();
    await t.connect();
    await t.write(Uint8Array.of(1, 2, 3));
    await t.endJob();
    expect(sockets[0]!.log).toEqual(['nodelay', 'write', 'destroy']);
    expect(await t.isConnected()).toBe(false);
    await expect(t.write(Uint8Array.of(2))).rejects.toMatchObject({ code: 'E_NOT_CONNECTED' });
    await t.connect();
    expect(sockets).toHaveLength(2);
  });

  it('endJob when there is no connection does nothing', async () => {
    const { t } = transportOf();
    await expect(t.endJob()).resolves.toBeUndefined();
  });

  it('turns Nagle off once the connection is open, and works with a socket that cannot', async () => {
    const a = transportOf();
    await a.t.connect();
    expect(a.sockets[0]!.log).toEqual(['nodelay']);
    const b = transportOf({}, { noNoDelay: true });
    await b.t.connect();
    expect(b.sockets[0]!.log).toEqual([]);
  });

  it('ignores a late event of an old socket', async () => {
    const { t, sockets } = transportOf();
    await t.connect();
    await t.connect();
    sockets[0]!.emit('close');
    sockets[0]!.emit('data', [7]);
    expect(await t.isConnected()).toBe(true);
    expect((await t.read({ timeoutMs: 40, idleMs: 10 })).length).toBe(0);
  });
});

describe('TcpTransport: a write is sent in pieces', () => {
  it('splits a job into pieces, in order, and reports progress after each', async () => {
    const { t, sockets } = transportOf({ chunkSize: 4 });
    await t.connect();
    const progress: Array<[number, number]> = [];
    await t.write(Uint8Array.from({ length: 10 }, (_, i) => i), { onProgress: (a, b) => progress.push([a, b]) });
    expect(sockets[0]!.sent).toEqual([[0, 1, 2, 3], [4, 5, 6, 7], [8, 9]]);
    expect(progress).toEqual([[4, 10], [8, 10], [10, 10]]);
  });

  it('an empty job writes nothing and does not fail', async () => {
    const { t, sockets } = transportOf();
    await t.connect();
    await expect(t.write(new Uint8Array(0))).resolves.toBeUndefined();
    expect(sockets[0]!.sent).toEqual([]);
  });

  it('cancel() stops between two pieces: E_CANCELLED, bytes sent are told, the connection closes', async () => {
    const { t, sockets } = transportOf({ chunkSize: 4 });
    await t.connect();
    const job = t.write(new Uint8Array(12), { onProgress: () => t.cancel() });
    await expect(job).rejects.toMatchObject({ code: 'E_CANCELLED', bytesSent: 4, nothingSent: false });
    expect(sockets[0]!.sent).toHaveLength(1);
    expect(sockets[0]!.log).toContain('destroy');
    expect(await t.isConnected()).toBe(false);
  });

  it('an aborted signal stops the write before its first piece: nothing was sent', async () => {
    const { t, sockets } = transportOf();
    await t.connect();
    const signal = { aborted: true, addEventListener: () => undefined, removeEventListener: () => undefined };
    await expect(t.write(Uint8Array.of(1), { signal })).rejects.toMatchObject({ code: 'E_CANCELLED', bytesSent: 0, nothingSent: true });
    expect(sockets[0]!.sent).toEqual([]);
  });

  it('a piece that does not finish is E_TIMEOUT for that piece, not for the whole job', async () => {
    const { t, sockets } = transportOf({ writeTimeoutMs: 20 }, { hangWrites: true });
    await t.connect();
    await expect(t.write(Uint8Array.of(1))).rejects.toMatchObject({ code: 'E_TIMEOUT', bytesSent: 0 });
    expect(sockets[0]!.log).toContain('destroy');
    expect(await t.isConnected()).toBe(false);
  });

  it('a write error in the second piece says one piece went out (it may have printed)', async () => {
    const { t } = transportOf({ chunkSize: 4 }, { failWriteAt: 2 });
    await t.connect();
    await expect(t.write(new Uint8Array(8))).rejects.toMatchObject({ code: 'E_WRITE', bytesSent: 4, nothingSent: false });
  });

  it('a long job to a slow printer is fine while every piece finishes in time', async () => {
    const { t } = transportOf({ chunkSize: 1, writeTimeoutMs: 50 });
    await t.connect();
    await expect(t.write(new Uint8Array(200))).resolves.toBeUndefined();
  });
});

describe('TcpTransport: link events', () => {
  async function events(run: (t: TcpTransport, sockets: ReturnType<typeof fakeSocket>[]) => Promise<void>, options = {}) {
    const { t, sockets } = transportOf(options);
    const seen: LinkEvent[] = [];
    t.onConnectionState((e) => seen.push(e));
    await run(t, sockets);
    return seen;
  }

  it('connecting, connected, writing, connected, then closed on purpose at endJob', async () => {
    const seen = await events(async (t) => { await t.connect(); await t.write(Uint8Array.of(1)); await t.endJob(); });
    expect(seen.map((e) => e.state)).toEqual(['connecting', 'connected', 'writing', 'connected', 'disconnected']);
    expect(seen[4]).toMatchObject({ state: 'disconnected', reason: 'requested' });
  });

  it('a close from the printer while the link is open is a lost link', async () => {
    const seen = await events(async (t, sockets) => { await t.connect(); sockets[0]!.emit('close'); });
    expect(seen[seen.length - 1]).toMatchObject({ state: 'disconnected', reason: 'closed by the printer' });
  });

  it('a socket error is reported with the error', async () => {
    const seen = await events(async (t, sockets) => { await t.connect(); sockets[0]!.emit('error', new Error('ECONNRESET')); });
    const last = seen[seen.length - 1]!;
    expect(last.state).toBe('disconnected');
    expect(last.error?.message).toBe('ECONNRESET');
  });

  it('a refused connect ends in disconnected with the error', async () => {
    const f = fakeSocket();
    const t = new TcpTransport({ host: 'h', port: 1, createConnection: () => { setTimeout(() => f.emit('error', new Error('ECONNREFUSED')), 0); return f.socket; } });
    const seen: LinkEvent[] = [];
    t.onConnectionState((e) => seen.push(e));
    await expect(t.connect()).rejects.toMatchObject({ code: 'E_CONNECT' });
    expect(seen.map((e) => e.state)).toEqual(['connecting', 'disconnected']);
  });

  it('removes a listener', async () => {
    const { t } = transportOf();
    const seen: LinkEvent[] = [];
    const off = t.onConnectionState((e) => seen.push(e));
    off();
    await t.connect();
    expect(seen).toEqual([]);
  });
});

describe('LabelPrinter over TcpTransport', () => {
  it('prints two jobs on two connections, each closed when its job is done, and the health is not "lost" between them', async () => {
    const { t, sockets } = transportOf();
    const lp = new LabelPrinter(t);
    await lp.printRaw(Uint8Array.of(1, 2));
    await lp.printRaw(Uint8Array.of(3));
    expect(sockets).toHaveLength(2);
    expect(sockets.map((s) => s.sent)).toEqual([[[1, 2]], [[3]]]);
    expect(sockets[0]!.log).toContain('destroy');
    expect(lp.health).not.toBe('lost');
    await lp.dispose();
  });

  it('asks a question on one connection, reads the reply, and only then closes', async () => {
    const { t, sockets } = transportOf();
    const lp = new LabelPrinter(t);
    const pending = lp.ask('~HS');
    // ask() first reads and drops old bytes (100 ms), then writes: the reply comes after that.
    await new Promise((r) => setTimeout(r, 200));
    expect(sockets[0]!.log).not.toContain('destroy');
    sockets[0]!.emit('data', Array.from(new TextEncoder().encode('\u0002030,0,0,1\u0003')));
    expect(await pending).toContain('030,0,0,1');
    expect(sockets[0]!.log).toContain('destroy');
    await lp.dispose();
  });

  it('a print whose close fails is still a print that went out: no error, no second send', async () => {
    const { t, sockets } = transportOf();
    t.endJob = () => Promise.reject(new Error('close failed'));
    const lp = new LabelPrinter(t);
    await expect(lp.printRaw(Uint8Array.of(1))).resolves.toBeUndefined();
    expect(sockets[0]!.sent).toEqual([[1]]);
    await lp.dispose();
  });
});
