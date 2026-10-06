import { TcpTransport, TcpSocketLike } from '../src/transports/tcp';
import { TransportError } from '../src/errors';

describe('TcpTransport', () => {
  it('connects, writes and reads', async () => {
    const handlers: Record<string, (...a: never[]) => void> = {};
    const sent: unknown[] = [];
    const socket: TcpSocketLike = {
      write: (data, _enc, cb) => { sent.push(data); cb?.(null); },
      on: (event, l) => { handlers[event] = l; return socket; },
      destroy: () => undefined,
    };
    const t = new TcpTransport({
      host: 'h',
      createConnection: (_o, onConnect) => { setTimeout(onConnect, 0); return socket; },
    });
    await t.connect();
    expect(await t.isConnected()).toBe(true);
    await t.write(Uint8Array.of(1, 2));
    expect(sent).toHaveLength(1);
    (handlers.data as unknown as (c: number[]) => void)([9, 8]);
    expect(Array.from(await t.read({ timeoutMs: 500, idleMs: 20 }))).toEqual([9, 8]);
    await t.disconnect();
    expect(await t.isConnected()).toBe(false);
  });
});

describe('TcpTransport (review)', () => {
  type Handler = (...a: never[]) => void;
  function fakeSocket() {
    const handlers: Record<string, Handler> = {};
    const sent: Uint8Array[] = [];
    let destroyed = 0;
    let writeError: Error | null = null;
    const socket: TcpSocketLike = {
      write: (data, _enc, cb) => { sent.push(Uint8Array.from(data as Uint8Array)); cb?.(writeError); },
      on: (event, l) => { handlers[event] = l; return socket; },
      destroy: () => { destroyed++; },
    };
    return { socket, handlers, sent, destroyed: () => destroyed, failWrites: (e: Error) => { writeError = e; } };
  }

  it('uses the host and port that it is given, and 9100 by default', async () => {
    const seen: Array<{ host: string; port: number }> = [];
    const f = fakeSocket();
    const make = (options?: { port?: number }) =>
      new TcpTransport({ host: 'printer.local', ...options, createConnection: (o, onConnect) => { seen.push(o); setTimeout(onConnect, 0); return f.socket; } });
    await make().connect();
    await make({ port: 9200 }).connect();
    expect(seen).toEqual([{ host: 'printer.local', port: 9100 }, { host: 'printer.local', port: 9200 }]);
  });

  it('rejects an empty host or a bad port before it opens a socket', async () => {
    const createConnection = jest.fn();
    await expect(new TcpTransport({ host: '', createConnection }).connect()).rejects.toMatchObject({ code: 'E_BAD_ADDRESS' });
    await expect(new TcpTransport({ host: 'h', port: 70000, createConnection }).connect()).rejects.toMatchObject({ code: 'E_BAD_ADDRESS' });
    expect(createConnection).not.toHaveBeenCalled();
  });

  it('sends all 256 byte values unchanged, in one write, also from a view', async () => {
    const f = fakeSocket();
    const t = new TcpTransport({ host: 'h', createConnection: (_o, c) => { setTimeout(c, 0); return f.socket; } });
    await t.connect();
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    await t.write(all);
    await t.write(new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4));
    expect(Array.from(f.sent[0]!)).toEqual(Array.from(all));
    expect(Array.from(f.sent[1]!)).toEqual([1, 2, 3]);
  });

  it('reports a connection error with the host and port, and a timeout', async () => {
    const f = fakeSocket();
    const t = new TcpTransport({ host: 'h', port: 1, createConnection: () => { setTimeout(() => (f.handlers.error as unknown as (e: Error) => void)(new Error('ECONNREFUSED')), 0); return f.socket; } });
    await expect(t.connect()).rejects.toMatchObject({ code: 'E_CONNECT', message: expect.stringContaining('h:1') });
    const slow = new TcpTransport({ host: 'h', connectTimeoutMs: 20, createConnection: () => f.socket });
    await expect(slow.connect()).rejects.toMatchObject({ code: 'E_TIMEOUT' });
  });

  it('maps a write error to E_WRITE, and says why a closed socket cannot write', async () => {
    const f = fakeSocket();
    const t = new TcpTransport({ host: 'h', createConnection: (_o, c) => { setTimeout(c, 0); return f.socket; } });
    await t.connect();
    f.failWrites(new Error('EPIPE'));
    await expect(t.write(Uint8Array.of(1))).rejects.toMatchObject({ code: 'E_WRITE', message: expect.stringContaining('EPIPE') });
    (f.handlers.error as unknown as (e: Error) => void)(new Error('ECONNRESET'));
    await expect(t.write(Uint8Array.of(1))).rejects.toMatchObject({ code: 'E_NOT_CONNECTED', message: expect.stringContaining('ECONNRESET') });
  });

  it('closes the old socket when connect() runs again', async () => {
    const a = fakeSocket();
    const t = new TcpTransport({ host: 'h', createConnection: (_o, c) => { setTimeout(c, 0); return a.socket; } });
    await t.connect();
    await t.connect();
    expect(a.destroyed()).toBe(1);
    await t.disconnect();
    expect(await t.isConnected()).toBe(false);
  });
});
