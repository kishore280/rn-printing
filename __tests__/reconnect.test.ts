import { LabelPrinter, TransportError, UnsupportedPlatformError } from '../src';
import type { ConnectionEvent } from '../src';
import { isTransient, resolveReconnect } from '../src/reconnect';
import { FakeTransport } from './helpers';

// cockatiel waits with real timers. Fake timers make the waits instant and let us read them.
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

/** Run a promise to the end while the fake clock moves forward. */
async function settle<T>(p: Promise<T>): Promise<T> {
  const done = p.then((v) => ({ v }), (e: unknown) => ({ e }));
  for (let i = 0; i < 40; i++) await jest.advanceTimersByTimeAsync(500);
  const r = await done;
  if ('e' in r) throw r.e;
  return r.v;
}

class Flaky extends FakeTransport {
  connectFails: Array<Error | null> = [];
  writeFails: Array<Error | null> = [];
  connects = 0;
  async connect() {
    this.connects++;
    const f = this.connectFails.shift();
    if (f) throw f;
    this.connected = true;
  }
  async write(data: Uint8Array) {
    const f = this.writeFails.shift();
    if (f) throw f;
    return super.write(data);
  }
}
const te = (code: string) => new TransportError(code, code);
const fixed = { jitter: false } as const;

describe('options', () => {
  it('rejects bad options', () => expect(() => resolveReconnect({ maxAttempts: 0 })).toThrow(RangeError));
  it('false means one attempt', () => expect(resolveReconnect(false).maxAttempts).toBe(1));
});

describe('isTransient', () => {
  it('splits transient and permanent errors', () => {
    expect(isTransient(te('E_CONNECT'))).toBe(true);
    expect(isTransient(te('E_PERMISSION'))).toBe(false);
    expect(isTransient(te('E_BLUETOOTH_OFF'))).toBe(false);
    expect(isTransient(new UnsupportedPlatformError('x'))).toBe(false);
  });
});

describe('LabelPrinter reconnect (cockatiel retry)', () => {
  it('connects by itself before the first print', async () => {
    const t = new Flaky();
    await settle(new LabelPrinter(t, { reconnect: fixed }).print('A'));
    expect(t.connects).toBe(1);
    expect(t.writtenText()).toBe('A');
  });

  it('retries connect with exponential backoff and reports events', async () => {
    const t = new Flaky();
    t.connectFails = [te('E_CONNECT'), te('E_CONNECT')];
    const events: ConnectionEvent[] = [];
    const p = new LabelPrinter(t, { reconnect: fixed, onConnectionEvent: (e) => events.push(e) });
    await settle(p.print('A'));
    expect(t.connects).toBe(3);
    expect(events.map((e) => e.type)).toEqual(['connecting', 'retry', 'connecting', 'retry', 'connecting', 'connected']);
    const delays = events.flatMap((e) => (e.type === 'retry' ? [e.delayMs] : []));
    expect(delays).toEqual([300, 600]);
  });

  it('uses jitter by default but stays under the cap', async () => {
    const t = new Flaky();
    t.connectFails = [te('E_CONNECT'), te('E_CONNECT')];
    const events: ConnectionEvent[] = [];
    await settle(new LabelPrinter(t, { onConnectionEvent: (e) => events.push(e) }).print('A'));
    for (const e of events) if (e.type === 'retry') expect(e.delayMs).toBeLessThanOrEqual(2000);
  });

  it('gives up after maxAttempts and reports failure', async () => {
    const t = new Flaky();
    t.connectFails = [te('E_CONNECT'), te('E_CONNECT'), te('E_CONNECT')];
    const events: ConnectionEvent[] = [];
    const p = new LabelPrinter(t, { reconnect: fixed, onConnectionEvent: (e) => events.push(e) });
    await expect(settle(p.print('A'))).rejects.toMatchObject({ code: 'E_CONNECT' });
    expect(t.connects).toBe(3);
    expect(events[events.length - 1]).toMatchObject({ type: 'failed', attempts: 3 });
    expect(t.written).toHaveLength(0);
  });

  it('does not retry a permanent error', async () => {
    const t = new Flaky();
    t.connectFails = [te('E_PERMISSION')];
    await expect(settle(new LabelPrinter(t, { reconnect: fixed }).print('A'))).rejects.toMatchObject({ code: 'E_PERMISSION' });
    expect(t.connects).toBe(1);
  });

  it('reconnects and resends when no byte was sent (E_NOT_CONNECTED)', async () => {
    const t = new Flaky();
    t.connected = true;
    t.writeFails = [te('E_NOT_CONNECTED')];
    await settle(new LabelPrinter(t, { reconnect: fixed }).print('A'));
    expect(t.connects).toBe(1);
    expect(t.writtenText()).toBe('A');
  });

  it('does NOT resend after a failed write by default, but the next job reconnects', async () => {
    const t = new Flaky();
    t.connected = true;
    t.writeFails = [te('E_WRITE')];
    const p = new LabelPrinter(t, { reconnect: fixed });
    await expect(settle(p.print('A'))).rejects.toMatchObject({ code: 'E_WRITE' });
    expect(t.written).toHaveLength(0);
    expect(t.connected).toBe(false);
    await settle(p.print('B'));
    expect(t.writtenText()).toBe('B');
    expect(t.connects).toBe(1);
  });

  it('resends after a failed write when resendAfterPartialWrite is on', async () => {
    const t = new Flaky();
    t.connected = true;
    t.writeFails = [te('E_WRITE')];
    await settle(new LabelPrinter(t, { reconnect: { ...fixed, resendAfterPartialWrite: true } }).print('A'));
    expect(t.writtenText()).toBe('A');
  });

  it('reconnect:false makes one attempt and no resend', async () => {
    const t = new Flaky();
    t.connectFails = [te('E_CONNECT')];
    await expect(settle(new LabelPrinter(t, { reconnect: false }).print('A'))).rejects.toBeDefined();
    expect(t.connects).toBe(1);
  });

  it('retries a status query once after a failure (it is safe to repeat)', async () => {
    const t = new Flaky();
    t.connected = true;
    let n = 0;
    const origWrite = t.write.bind(t);
    t.write = async (d: Uint8Array) => {
      if (n++ === 0) throw te('E_WRITE');
      return origWrite(d);
    };
    await expect(settle(new LabelPrinter(t, { reconnect: fixed }).getStatus())).resolves.toBeNull();
    expect(t.connects).toBe(1);
  });

  it('keeps jobs in order while reconnecting', async () => {
    const t = new Flaky();
    t.connectFails = [te('E_CONNECT')];
    const p = new LabelPrinter(t, { reconnect: fixed });
    await settle(Promise.all([p.print('A'), p.print('B'), p.print('C')]));
    expect(t.writtenText()).toBe('A|B|C');
  });
});
