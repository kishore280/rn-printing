import { LabelPrinter } from '../src/printer';
import { TcpTransport, type TcpSocketLike } from '../src/transports/tcp';
import type { LinkEvent } from '../src/transport';

type Handler = (...a: never[]) => void;

/** A fake `react-native-tcp-socket` socket that records what happens to it. */
function fakeSocket(options: { hangWrites?: boolean; noEnd?: boolean } = {}) {
  const handlers: Record<string, Handler> = {};
  const log: string[] = [];
  const sent: number[][] = [];
  const socket: TcpSocketLike = {
    write: (data, _enc, cb) => {
      sent.push(Array.from(data as Uint8Array));
      log.push('write');
      if (!options.hangWrites) cb?.(null);
    },
    on: (event, l) => { handlers[event] = l; return socket; },
    destroy: () => { log.push('destroy'); },
    ...(options.noEnd ? {} : { end: () => { log.push('end'); } }),
  };
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
  it('sends FIN after the write, in this order: write, then end', async () => {
    const { t, sockets } = transportOf();
    await t.connect();
    await t.write(Uint8Array.of(1, 2, 3));
    expect(sockets[0]!.log).toEqual(['write', 'end']);
    expect(sockets[0]!.sent).toEqual([[1, 2, 3]]);
  });

  it('counts the link as closed after the job, so the next job opens a new connection', async () => {
    const { t, sockets } = transportOf();
    await t.connect();
    await t.write(Uint8Array.of(1));
    expect(await t.isConnected()).toBe(false);
    await expect(t.write(Uint8Array.of(2))).rejects.toMatchObject({ code: 'E_NOT_CONNECTED' });
    await t.connect();
    expect(sockets).toHaveLength(2);
    expect(sockets[0]!.log).toContain('destroy');
  });

  it('still reads the printer reply after the half-close', async () => {
    const { t, sockets } = transportOf();
    await t.connect();
    await t.write(new TextEncoder().encode('~HS'));
    sockets[0]!.emit('data', [0x02, 0x41, 0x03]);
    expect(Array.from(await t.read({ timeoutMs: 300, idleMs: 20 }))).toEqual([0x02, 0x41, 0x03]);
  });

  it('does not half-close with endOfJob none, and the link stays open', async () => {
    const { t, sockets } = transportOf({ endOfJob: 'none' });
    await t.connect();
    await t.write(Uint8Array.of(1));
    await t.write(Uint8Array.of(2));
    expect(sockets[0]!.log).toEqual(['write', 'write']);
    expect(await t.isConnected()).toBe(true);
  });

  it('keeps the link open when the socket has no end(): it cannot half-close', async () => {
    const { t, sockets } = transportOf({}, { noEnd: true });
    await t.connect();
    await t.write(Uint8Array.of(1));
    expect(sockets[0]!.log).toEqual(['write']);
    expect(await t.isConnected()).toBe(true);
  });

  it('frees the socket when the printer does not close it, after closeWaitMs', async () => {
    const { t, sockets } = transportOf({ closeWaitMs: 20 });
    await t.connect();
    await t.write(Uint8Array.of(1));
    expect(sockets[0]!.log).not.toContain('destroy');
    await new Promise((r) => setTimeout(r, 60));
    expect(sockets[0]!.log).toEqual(['write', 'end', 'destroy']);
  });

  it('does not destroy the socket early when the printer closes it first', async () => {
    const { t, sockets } = transportOf({ closeWaitMs: 20 });
    await t.connect();
    await t.write(Uint8Array.of(1));
    sockets[0]!.emit('close');
    await new Promise((r) => setTimeout(r, 60));
    expect(sockets[0]!.log).toEqual(['write', 'end']);
  });

  it('fails a write that does not finish: E_TIMEOUT, socket destroyed', async () => {
    const { t, sockets } = transportOf({ writeTimeoutMs: 20 }, { hangWrites: true });
    await t.connect();
    await expect(t.write(Uint8Array.of(1))).rejects.toMatchObject({ code: 'E_TIMEOUT' });
    expect(sockets[0]!.log).toContain('destroy');
    expect(await t.isConnected()).toBe(false);
  });

  it('ignores a late event of an old socket', async () => {
    const { t, sockets } = transportOf({ endOfJob: 'none' });
    await t.connect();
    await t.connect();
    sockets[0]!.emit('close');
    sockets[0]!.emit('data', [7]);
    expect(await t.isConnected()).toBe(true);
    expect((await t.read({ timeoutMs: 40, idleMs: 10 })).length).toBe(0);
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

  it('connecting, connected, writing, then closed on purpose after a job', async () => {
    const seen = await events(async (t) => { await t.connect(); await t.write(Uint8Array.of(1)); });
    expect(seen.map((e) => e.state)).toEqual(['connecting', 'connected', 'writing', 'disconnected']);
    expect(seen[3]).toMatchObject({ state: 'disconnected', reason: 'requested' });
  });

  it('a close from the printer while the link is open is a lost link', async () => {
    const seen = await events(async (t, sockets) => { await t.connect(); sockets[0]!.emit('close'); }, { endOfJob: 'none' });
    expect(seen[seen.length - 1]).toMatchObject({ state: 'disconnected', reason: 'closed by the printer' });
  });

  it('a socket error is reported with the error', async () => {
    const seen = await events(async (t, sockets) => { await t.connect(); sockets[0]!.emit('error', new Error('ECONNRESET')); }, { endOfJob: 'none' });
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
  it('prints two jobs on two connections and the health is not "lost" between them', async () => {
    const { t, sockets } = transportOf();
    const lp = new LabelPrinter(t);
    await lp.printRaw(Uint8Array.of(1, 2));
    await lp.printRaw(Uint8Array.of(3));
    expect(sockets).toHaveLength(2);
    expect(sockets.map((s) => s.sent)).toEqual([[[1, 2]], [[3]]]);
    expect(lp.health).not.toBe('lost');
    await lp.dispose();
  });

  it('asks a question on one connection and reads the reply', async () => {
    const { t, sockets } = transportOf();
    const lp = new LabelPrinter(t);
    const pending = lp.ask('~HS');
    // ask() first reads and drops old bytes (100 ms), then writes: the reply comes after that.
    await new Promise((r) => setTimeout(r, 200));
    sockets[0]!.emit('data', Array.from(new TextEncoder().encode('\u0002030,0,0,1\u0003')));
    expect(await pending).toContain('030,0,0,1');
    await lp.dispose();
  });
});
