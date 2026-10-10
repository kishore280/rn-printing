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
import { Platform } from 'react-native';

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
  reads: string[];
  pieceTimes: number[];
  push: ((data: ArrayBuffer) => void) | null;
  lose: ((reason: string) => void) | null;
}

/** A link that records what happens to it. `onWrite` can delay or fail the n-th native write. */
function install(options: { bondMs?: number; gatt?: typeof gatt; readFails?: boolean; onWrite?: (index: number, probe: Probe) => Promise<void> } = {}): Probe {
  const probe: Probe = { connected: true, writes: [], bonds: 0, reads: [], pieceTimes: [], push: null, lose: null };
  const link = {
    id: 'd',
    get isConnected() {
      return probe.connected;
    },
    mtu: 23,
    noResponseCallback: 'unknown',
    bondState: 'none',
    requestMtu: async () => 23,
    discover: async () => options.gatt ?? gatt,
    maxWriteLength: () => 20,
    write: async (_s: string, _c: string, data: ArrayBuffer) => {
      const index = probe.writes.length;
      probe.writes.push(Array.from(new Uint8Array(data)));
      probe.pieceTimes.push(Date.now());
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
    read: async (_s: string, c: string) => {
      probe.reads.push(c);
      if (options.readFails) throw new TransportError('insufficient authentication', 'E_AUTH');
      return new ArrayBuffer(0);
    },
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

const GAP_SVC = '00001800-0000-1000-8000-00805f9b34fb';
const DEVICE_NAME = '00002a00-0000-1000-8000-00805f9b34fb';
const withDeviceName = [
  { serviceUuid: GAP_SVC, uuid: DEVICE_NAME, read: true, write: false, writeWithoutResponse: false, notify: false, indicate: false },
  ...gatt,
];

describe('BluetoothLETransport: found by the second review (Classic, connect path and the end of a job)', () => {
  it('a disconnect right after a write without response asks the printer one question first: the queued data is sent before the close', async () => {
    const probe = install({ gatt: withDeviceName });
    const transport = new BluetoothLETransport('dev', { chunkDelayMs: 0 });
    await transport.connect();
    await transport.write(new Uint8Array(40));
    await transport.disconnect();
    expect(probe.reads).toEqual([DEVICE_NAME]);
  });

  it('no question when the last write had a response, or when no write came lately', async () => {
    const probe = install({ gatt: withDeviceName });
    const transport = new BluetoothLETransport('dev', { writeMode: 'write', chunkDelayMs: 0 });
    await transport.connect();
    await transport.write(new Uint8Array(40));
    await transport.disconnect();
    expect(probe.reads).toEqual([]);
    const idle = install({ gatt: withDeviceName });
    const quiet = new BluetoothLETransport('dev', {});
    await quiet.connect();
    await quiet.disconnect();
    expect(idle.reads).toEqual([]);
  });

  it('a printer with no Device Name characteristic is closed at once, and a failed question does not fail the disconnect', async () => {
    const probe = install();
    const transport = new BluetoothLETransport('dev', { chunkDelayMs: 0 });
    await transport.connect();
    await transport.write(new Uint8Array(40));
    await expect(transport.disconnect()).resolves.toBeUndefined();
    expect(probe.reads).toEqual([]);
    const failing = install({ gatt: withDeviceName, readFails: true });
    const other = new BluetoothLETransport('dev', { chunkDelayMs: 0 });
    await other.connect();
    await other.write(new Uint8Array(40));
    await expect(other.disconnect()).resolves.toBeUndefined();
    expect(failing.reads).toEqual([DEVICE_NAME]);
  });

  it('on iOS there is no pause between pieces: CoreBluetooth says when the next write may go', async () => {
    const original = Platform.OS;
    (Platform as { OS: string }).OS = 'ios';
    try {
      const probe = install();
      const transport = new BluetoothLETransport('dev', {});
      await transport.connect();
      await transport.write(new Uint8Array(100)); // 5 pieces of 20
      const gaps = probe.pieceTimes.slice(1).map((t, i) => t - (probe.pieceTimes[i] ?? 0));
      expect(gaps.every((g) => g < 9)).toBe(true);
    } finally {
      (Platform as { OS: string }).OS = original;
    }
  });
});
