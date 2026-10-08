import { HARD_FAILS_FOR_LOST, HEALTH_GRACE_MS, HEALTH_START, observe, settle, settleDelay } from '../src/linkHealth';
import { TransportError } from '../src/errors';
import { LabelPrinter } from '../src/printer';
import type { LinkEvent, LinkState } from '../src/transport';
import { FakeTransport } from './helpers';

describe('linkHealth rules', () => {
  const up = observe(HEALTH_START, { kind: 'alive' }, 0);

  it('up shows at once, with no delay', () => {
    expect(up.health).toBe('up');
  });

  it('one down signal is a wobble, not a loss', () => {
    expect(observe(up, { kind: 'down' }, 1000).health).toBe('wobbling');
  });

  it('a wobble becomes lost only after the grace time', () => {
    const w = observe(up, { kind: 'down' }, 1000);
    expect(settle(w, 1000 + HEALTH_GRACE_MS - 1).health).toBe('wobbling');
    expect(settle(w, 1000 + HEALTH_GRACE_MS).health).toBe('lost');
    expect(settleDelay(w, 1000)).toBe(HEALTH_GRACE_MS);
    expect(settleDelay(w, 1000 + HEALTH_GRACE_MS + 5)).toBe(0);
  });

  it('a sign of life ends the wobble at once and clears the count', () => {
    const w = observe(up, { kind: 'failed' }, 1000);
    const back = observe(w, { kind: 'alive' }, 1500);
    expect(back).toEqual({ health: 'up', downSince: null, hardFails: 0 });
  });

  it(`${HARD_FAILS_FOR_LOST} hard failures in a row are lost without waiting`, () => {
    const one = observe(up, { kind: 'failed' }, 1000);
    expect(one.health).toBe('wobbling');
    expect(observe(one, { kind: 'failed' }, 1100).health).toBe('lost');
  });

  it('the first down before any life is not a loss (a failed first connect)', () => {
    expect(observe(HEALTH_START, { kind: 'down' }, 0)).toEqual(HEALTH_START);
  });

  it('closing on purpose is neither wobble nor loss', () => {
    expect(observe(up, { kind: 'closed' }, 5)).toEqual(HEALTH_START);
  });

  it('a lost link stays lost for more down signals, and settle does nothing to other states', () => {
    const lost = settle(observe(up, { kind: 'down' }, 0), HEALTH_GRACE_MS);
    expect(observe(lost, { kind: 'down' }, HEALTH_GRACE_MS + 1).health).toBe('lost');
    expect(settle(up, 1e9)).toBe(up);
    expect(settleDelay(up, 0)).toBeNull();
  });
});

/** A transport that can emit link events, as the BLE transport does. */
class EventTransport extends FakeTransport {
  state: LinkState = 'disconnected';
  private listeners = new Set<(e: LinkEvent) => void>();
  onConnectionState(l: (e: LinkEvent) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(e: LinkEvent) {
    this.state = e.state;
    for (const l of [...this.listeners]) l(e);
  }
  count() {
    return this.listeners.size;
  }
}

describe('LabelPrinter.health', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('follows the transport: connected is up, one lost link wobbles, then is lost after the grace time', () => {
    const t = new EventTransport();
    const p = new LabelPrinter(t);
    const seen: string[] = [];
    p.onHealth((h) => seen.push(h));
    expect(p.health).toBe('unknown');
    t.emit({ state: 'connected' });
    t.emit({ state: 'disconnected', reason: 'GATT status 8' });
    expect(p.health).toBe('wobbling');
    jest.advanceTimersByTime(HEALTH_GRACE_MS - 1);
    expect(p.health).toBe('wobbling');
    jest.advanceTimersByTime(1);
    expect(p.health).toBe('lost');
    expect(seen).toEqual(['up', 'wobbling', 'lost']);
  });

  it('a link that comes back inside the grace time never shows lost (no flicker)', () => {
    const t = new EventTransport();
    const p = new LabelPrinter(t);
    const seen: string[] = [];
    p.onHealth((h) => seen.push(h));
    t.emit({ state: 'connected' });
    t.emit({ state: 'disconnected', reason: 'x' });
    jest.advanceTimersByTime(2000);
    t.emit({ state: 'connected' });
    jest.advanceTimersByTime(10_000);
    expect(p.health).toBe('up');
    expect(seen).toEqual(['up', 'wobbling', 'up']);
  });

  it('a failed write (disconnected with an error) twice in a row is lost at once', () => {
    const t = new EventTransport();
    const p = new LabelPrinter(t);
    t.emit({ state: 'connected' });
    t.emit({ state: 'disconnected', reason: 'write failed', error: new TransportError('x', 'E_WRITE') });
    expect(p.health).toBe('wobbling');
    t.emit({ state: 'disconnected', reason: 'write failed', error: new TransportError('x', 'E_WRITE') });
    expect(p.health).toBe('lost');
  });

  it('a close that we asked for is not a loss', () => {
    const t = new EventTransport();
    const p = new LabelPrinter(t);
    t.emit({ state: 'connected' });
    t.emit({ state: 'disconnected', reason: 'requested' });
    expect(p.health).toBe('unknown');
    jest.advanceTimersByTime(60_000);
    expect(p.health).toBe('unknown');
  });

  it('a transport with no events leaves health at unknown, and the connect events still make it up', async () => {
    const p = new LabelPrinter(new FakeTransport());
    expect(p.health).toBe('unknown');
    await p.connect();
    expect(p.health).toBe('up');
  });

  it('a first connect that fails after every try is a plain failure, not a loss', async () => {
    const t = new FakeTransport();
    t.connect = async () => {
      throw new TransportError('no', 'E_CONNECT');
    };
    const p = new LabelPrinter(t, { reconnect: { maxAttempts: 1 } });
    await p.connect().catch(() => undefined);
    // Never was up: nothing to lose.
    expect(p.health).toBe('unknown');
  });

  it('dispose removes the transport listener, the timer and the health listeners', async () => {
    const t = new EventTransport();
    const p = new LabelPrinter(t);
    const seen: string[] = [];
    p.onHealth((h) => seen.push(h));
    t.emit({ state: 'connected' });
    t.emit({ state: 'disconnected', reason: 'x' });
    await p.dispose();
    expect(t.count()).toBe(0);
    jest.advanceTimersByTime(60_000);
    expect(seen).toEqual(['up', 'wobbling']);
  });
});
