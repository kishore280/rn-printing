/**
 * Found by an independent review of the BLE write path against BlueZ (`att.c`, `gatt-client.c`) and Android's GATT code
 * (`BluetoothGatt.java`, `gatt_cl.cc`). Each test fails without its fix. See docs/BLE-HARDENING.md, section 12.
 */
import { TransportError } from '../src/errors';
import { setBluetoothLE } from '../src/native';
import type { BleConnection } from '../src/specs/BleConnection.nitro';
import type { BluetoothLE as NativeBluetoothLE } from '../src/specs/BluetoothLE.nitro';
import { INBOX_LIMIT } from '../src/transports/inbox';
import { BluetoothLETransport } from '../src/transports/bluetoothLE';

const SVC = '11111111-0000-0000-0000-000000000001';
const TX = '11111111-0000-0000-0000-0000000000a1';
const RX = '11111111-0000-0000-0000-0000000000a2';
const gatt = [
  { serviceUuid: SVC, uuid: RX, read: false, write: false, writeWithoutResponse: false, notify: true, indicate: false },
  { serviceUuid: SVC, uuid: TX, read: false, write: true, writeWithoutResponse: true, notify: false, indicate: false },
];

interface Probe {
  connected: boolean;
  writes: number[][];
  bonds: number;
  push: ((data: ArrayBuffer) => void) | null;
  lose: ((reason: string) => void) | null;
}

/** A link that records what happens to it. `onWrite` can delay or fail the n-th native write. */
function install(options: { bondMs?: number; onWrite?: (index: number, probe: Probe) => Promise<void> } = {}): Probe {
  const probe: Probe = { connected: true, writes: [], bonds: 0, push: null, lose: null };
  const link = {
    id: 'd',
    get isConnected() {
      return probe.connected;
    },
    mtu: 23,
    noResponseCallback: 'unknown',
    bondState: 'none',
    requestMtu: async () => 23,
    discover: async () => gatt,
    maxWriteLength: () => 20,
    write: async (_s: string, _c: string, data: ArrayBuffer) => {
      const index = probe.writes.length;
      probe.writes.push(Array.from(new Uint8Array(data)));
      await new Promise((r) => setTimeout(r, 1));
      await options.onWrite?.(index, probe);
    },
    bond: async () => {
      probe.bonds++;
      await new Promise((r) => setTimeout(r, options.bondMs ?? 0));
      return true;
    },
    subscribe: async (_s: string, _c: string, cb: (data: ArrayBuffer) => void) => {
      probe.push = cb;
    },
    unsubscribe: async () => undefined,
    read: async () => new ArrayBuffer(0),
    disconnect: async () => {
      probe.connected = false;
    },
  };
  // The native objects are fakes with the part of the interface that the transport uses.
  setBluetoothLE({
    getState: () => 'on',
    setStateListener: () => undefined,
    connect: async (_id: string, _timeout: number, onDisconnect: (reason: string) => void) => {
      probe.lose = (reason) => {
        probe.connected = false;
        onDisconnect(reason);
      };
      return link as unknown as BleConnection;
    },
  } as unknown as NativeBluetoothLE);
  return probe;
}

afterEach(() => setBluetoothLE(undefined));

describe('BluetoothLETransport: found by the BlueZ / Android review', () => {
  it('a pairing in the middle of a write is not cut by the write guard: bondTimeoutMs is its limit', async () => {
    let first = true;
    const probe = install({
      bondMs: 1500,
      onWrite: async () => {
        if (!first) return;
        first = false;
        throw new TransportError('needs pairing', 'E_AUTH');
      },
    });
    const transport = new BluetoothLETransport('dev', { writeTimeoutMs: 200, bondTimeoutMs: 30000, writeMode: 'write' });
    await transport.connect();
    await transport.write(Uint8Array.of(1, 2, 3));
    expect(probe.bonds).toBe(1);
    // The piece went out once before the pairing and once after it.
    expect(probe.writes).toHaveLength(2);
  });

  it('a link lost while the last piece finishes does not turn the state back to connected', async () => {
    const probe = install({
      onWrite: async (index, p) => {
        if (index === 1) p.lose?.('supervision timeout');
      },
    });
    const transport = new BluetoothLETransport('dev', { chunkDelayMs: 0 });
    await transport.connect();
    await transport.write(new Uint8Array(40));
    expect(await transport.isConnected()).toBe(false);
    expect(transport.connectionState).toBe('disconnected');
  });

  it('the inbox keeps the newest bytes and has a limit: a printer that talks and a reader that never comes cannot fill the memory', async () => {
    const probe = install();
    const transport = new BluetoothLETransport('dev', {});
    await transport.connect();
    const chunk = new Uint8Array(244).fill(7).buffer;
    for (let i = 0; i < 1000; i++) probe.push?.(chunk);
    const reply = await transport.read({ timeoutMs: 100, idleMs: 20 });
    expect(reply.length).toBe(INBOX_LIMIT);
  });
});
