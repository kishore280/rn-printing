import { BleTransport, BleClient, BleCharacteristicInfo } from '../src/transports/ble';
import { TcpTransport, TcpSocketLike } from '../src/transports/tcp';
import { TransportError } from '../src/errors';

class FakeBle implements BleClient {
  writes: Array<{ s: string; c: string; data: number[]; withResponse: boolean }> = [];
  listener: ((d: Uint8Array) => void) | null = null;
  constructor(private readonly list: BleCharacteristicInfo[]) {}
  async connect() {}
  async disconnect() {}
  async isConnected() { return true; }
  async discover() { return this.list; }
  async write(s: string, c: string, data: Uint8Array, withResponse: boolean) {
    this.writes.push({ s, c, data: Array.from(data), withResponse });
  }
  async subscribe(_s: string, _c: string, onData: (d: Uint8Array) => void) {
    this.listener = onData;
    return () => { this.listener = null; };
  }
}

const chars: BleCharacteristicInfo[] = [
  { serviceUuid: 'A', uuid: 'n', writable: false, writableWithoutResponse: false, notifiable: true },
  { serviceUuid: 'A', uuid: 'w', writable: false, writableWithoutResponse: true, notifiable: false },
];

describe('BleTransport', () => {
  it('picks characteristics, splits writes and reads replies', async () => {
    const client = new FakeBle(chars);
    const t = new BleTransport({ deviceId: 'x', client, chunkSize: 4 });
    await t.connect();
    await t.write(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(client.writes.map((w) => w.data)).toEqual([[1, 2, 3, 4], [5, 6, 7, 8], [9]]);
    expect(client.writes[0]).toMatchObject({ s: 'A', c: 'w', withResponse: false });
    client.listener?.(Uint8Array.from([7, 8]));
    expect(Array.from(await t.read({ timeoutMs: 500, idleMs: 20 }))).toEqual([7, 8]);
    await t.disconnect();
    expect(client.listener).toBeNull();
  });

  it('fails when nothing is writable', async () => {
    const t = new BleTransport({ deviceId: 'x', client: new FakeBle([chars[0]!]) });
    await expect(t.connect()).rejects.toBeInstanceOf(TransportError);
  });

  it('fails to write before connect', async () => {
    const t = new BleTransport({ deviceId: 'x', client: new FakeBle(chars) });
    await expect(t.write(Uint8Array.of(1))).rejects.toMatchObject({ code: 'E_NOT_CONNECTED' });
  });
});

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
