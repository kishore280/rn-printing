import { TransportError } from '../src/errors';
import { LabelPrinter } from '../src/printer';
import { setBluetoothLE } from '../src/native';
import type { BleCharacteristic } from '../src/specs/BleCharacteristic';
import type { BleConnection } from '../src/specs/BleConnection.nitro';
import type { BleScanOptions } from '../src/specs/BleScanOptions';
import type { BleScanResult } from '../src/specs/BleScanResult';
import type { BluetoothLE as NativeBluetoothLE } from '../src/specs/BluetoothLE.nitro';
import { describeGatt, normalizeUuid, selectCharacteristics } from '../src/transports/bleGatt';
import { BleDevice, bleFilters, BluetoothLE, BluetoothLETransport, classify } from '../src/transports/bluetoothLE';
import { ZplLabel } from '../src/zpl';

// ---- fakes ----

const ch = (
  serviceUuid: string,
  uuid: string,
  p: Partial<Omit<BleCharacteristic, 'serviceUuid' | 'uuid'>> = {}
): BleCharacteristic => ({
  serviceUuid,
  uuid,
  read: false,
  write: false,
  writeWithoutResponse: false,
  notify: false,
  indicate: false,
  ...p,
});

/** A made-up serial-style service: one write characteristic and one notify characteristic. */
const SERIAL_SVC = '11111111-0000-0000-0000-000000000001';
const SERIAL_TX = '11111111-0000-0000-0000-0000000000a1';
const SERIAL_RX = '11111111-0000-0000-0000-0000000000a2';
const serialGatt = (): BleCharacteristic[] => [
  ch('00001800-0000-1000-8000-00805f9b34fb', '00002a00-0000-1000-8000-00805f9b34fb', { read: true, write: true }),
  ch(SERIAL_SVC, SERIAL_RX, { notify: true }),
  ch(SERIAL_SVC, SERIAL_TX, { write: true, writeWithoutResponse: true }),
];

interface FakeLinkOptions {
  /** The phone reports a bond already (the printer may have forgotten it). */
  bondedAlready?: boolean;
  gatt?: BleCharacteristic[];
  mtu?: number;
  maxWrite?: (withResponse: boolean) => number;
  writeImpl?: (index: number, bytes: number[]) => Promise<void>;
  requestMtuImpl?: (mtu: number) => Promise<number>;
  discoverImpl?: () => Promise<BleCharacteristic[]>;
  noResponseCallback?: string;
  readImpl?: (s: string, c: string) => Promise<Uint8Array>;
  subscribeImpl?: (call: number) => Promise<void>;
  bondImpl?: (link: { connected: boolean }) => Promise<boolean>;
}

class FakeLink {
  connected = true;
  writes: Array<{ s: string; c: string; bytes: number[]; withResponse: boolean; timeoutMs: number }> = [];
  mtuRequests: number[] = [];
  subscribed: string[] = [];
  unsubscribed: string[] = [];
  disconnects = 0;
  bonds = 0;
  subscribeCalls = 0;
  push: ((d: ArrayBuffer) => void) | null = null;
  inFlight = 0;
  maxInFlight = 0;
  constructor(readonly opts: FakeLinkOptions, readonly lost: (reason: string) => void) {}

  asNative(): BleConnection {
    const self = this;
    return {
      id: 'dev-1',
      get isConnected() { return self.connected; },
      get mtu() { return self.opts.mtu ?? 23; },
      get noResponseCallback() { return self.opts.noResponseCallback ?? 'unknown'; },
      requestMtu: async (mtu: number) => {
        self.mtuRequests.push(mtu);
        return self.opts.requestMtuImpl ? self.opts.requestMtuImpl(mtu) : (self.opts.mtu ?? 23);
      },
      discover: async () => (self.opts.discoverImpl ? self.opts.discoverImpl() : self.opts.gatt ?? serialGatt()),
      maxWriteLength: (withResponse: boolean) =>
        self.opts.maxWrite ? self.opts.maxWrite(withResponse) : (self.opts.mtu ?? 23) - 3,
      write: async (s: string, c: string, data: ArrayBuffer, withResponse: boolean, timeoutMs: number) => {
        const bytes = Array.from(new Uint8Array(data));
        self.inFlight++;
        self.maxInFlight = Math.max(self.maxInFlight, self.inFlight);
        try {
          const index = self.writes.length;
          self.writes.push({ s, c, bytes, withResponse, timeoutMs });
          await new Promise<void>((r) => setTimeout(r, 1));
          if (self.opts.writeImpl) await self.opts.writeImpl(index, bytes);
        } finally {
          self.inFlight--;
        }
      },
      get bondState() { return self.opts.bondedAlready ? 'bonded' : 'none'; },
      bond: async () => {
        self.bonds++;
        return self.opts.bondImpl ? self.opts.bondImpl(self) : true;
      },
      subscribe: async (s: string, c: string, onData: (d: ArrayBuffer) => void) => {
        if (self.opts.subscribeImpl) await self.opts.subscribeImpl(++self.subscribeCalls);
        self.subscribed.push(`${s}/${c}`);
        self.push = onData;
      },
      read: async (s: string, c: string) => {
        const v = self.opts.readImpl ? await self.opts.readImpl(s, c) : new Uint8Array([1, 2]);
        return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
      },
      unsubscribe: async (s: string, c: string) => { self.unsubscribed.push(`${s}/${c}`); },
      disconnect: async () => { self.disconnects++; self.connected = false; },
    } as unknown as BleConnection;
  }
}

interface FakeNativeOptions extends FakeLinkOptions {
  state?: string;
  connectError?: Error;
  /** Ids the phone does not know: connect fails with E_DEVICE_NOT_FOUND, as iOS does. */
  unknownIds?: string[];
  enableAnswer?: boolean;
  enableError?: Error;
  /** Called for each scan. Emit results through `emit`, then resolve to end the scan. */
  scanImpl?: (options: BleScanOptions, emit: (r: BleScanResult) => void) => Promise<void>;
}

function fakeNative(opts: FakeNativeOptions = {}) {
  const links: FakeLink[] = [];
  const connectCalls: Array<{ id: string; timeoutMs: number }> = [];
  let stopCalls = 0;
  let stateListener: ((s: string) => void) | null = null;
  let stopScanResolver: (() => void) | null = null;
  let enableCalls = 0;
  const mod = {
    getState: () => opts.state ?? 'on',
    setStateListener: (l: (s: string) => void) => { stateListener = l; },
    requestEnable: async () => { enableCalls++; if (opts.enableError) throw opts.enableError; return opts.enableAnswer ?? true; },
    scan: (options: BleScanOptions, onResult: (r: BleScanResult) => void) =>
      opts.scanImpl
        ? opts.scanImpl(options, onResult)
        : new Promise<void>((resolve) => { stopScanResolver = resolve; }),
    stopScan: async () => { stopCalls++; stopScanResolver?.(); },
    connect: async (id: string, timeoutMs: number, onDisconnect: (reason: string) => void) => {
      connectCalls.push({ id, timeoutMs });
      if (opts.unknownIds?.includes(id)) throw new Error('[E_DEVICE_NOT_FOUND] The id is not known to this phone. Scan first.');
      if (opts.connectError) throw opts.connectError;
      const link = new FakeLink(opts, (reason) => { link.connected = false; onDisconnect(reason); });
      links.push(link);
      return link.asNative();
    },
  } as unknown as NativeBluetoothLE;
  setBluetoothLE(mod);
  return { links, connectCalls, enableCalls: () => enableCalls, stopCalls: () => stopCalls, emitState: (s: string) => stateListener?.(s) };
}

const scanResult = (id: string, name: string, rssi?: number, extra: Partial<BleScanResult> = {}): BleScanResult => ({
  id, name, rssi, connectable: true, serviceUuids: [], manufacturerData: '', ...extra,
});

const bytes = (n: number, seed = 1): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);

afterEach(() => setBluetoothLE(undefined));

// ---- scanning ----

describe('BluetoothLE.scan', () => {
  it('maps results, drops duplicates, applies the filter and sorts by RSSI', async () => {
    fakeNative({
      scanImpl: async (_o, emit) => {
        emit(scanResult('a', 'Label-A', -80, { serviceUuids: ['s1'], manufacturerData: '4c00aa', txPower: -4 }));
        emit(scanResult('b', '', undefined));
        emit(scanResult('c', 'Label-C', -40));
        emit(scanResult('c', 'Label-C', -35)); // same device again
        emit(scanResult('d', 'Other', -20));
      },
    });
    const seen: string[] = [];
    const list = await BluetoothLE.scan({ filter: bleFilters.name('label'), onDevice: (d) => seen.push(d.id) });
    expect(list.map((d) => d.id)).toEqual(['c', 'a']);
    expect(seen).toEqual(['a', 'c']);
    expect(list[1]).toEqual({
      id: 'a', name: 'Label-A', rssi: -80, connectable: true, serviceUuids: ['s1'], manufacturerData: '4c00aa', txPower: -4,
    });
  });

  it('turns empty name and missing numbers into null', async () => {
    fakeNative({ scanImpl: async (_o, emit) => emit(scanResult('b', '')) });
    const [d] = await BluetoothLE.scan();
    expect(d).toMatchObject({ name: null, rssi: null, manufacturerData: null, txPower: null });
  });

  it('passes the platform options and the defaults', async () => {
    let seen: BleScanOptions | null = null;
    fakeNative({ scanImpl: async (o) => { seen = o; } });
    await BluetoothLE.scan();
    expect(seen).toEqual({ serviceUuids: [], timeoutMs: 5000, allowDuplicates: false });
    await BluetoothLE.scan({ serviceUuids: ['abcd'], timeoutMs: 0, allowDuplicates: true });
    expect(seen).toEqual({ serviceUuids: ['abcd'], timeoutMs: 0, allowDuplicates: true });
  });

  it('stops on abort and returns what it found', async () => {
    const fake = fakeNative({
      scanImpl: (_o, emit) => new Promise<void>((resolve) => {
        emit(scanResult('a', 'A', -50));
        // the scan ends when stopScan() is called
        setTimeout(resolve, 20);
      }),
    });
    let onAbort: (() => void) | null = null;
    const signal = {
      aborted: false,
      addEventListener: (_t: 'abort', l: () => void) => { onAbort = l; },
      removeEventListener: () => undefined,
    };
    const p = BluetoothLE.scan({ signal });
    signal.aborted = true;
    (onAbort as (() => void) | null)?.();
    const list = await p;
    expect(fake.stopCalls()).toBe(1);
    expect(list.map((d) => d.id)).toEqual(['a']);
  });

  it('returns nothing when the signal is aborted before the scan', async () => {
    const fake = fakeNative();
    const signal = { aborted: true, addEventListener: () => undefined, removeEventListener: () => undefined };
    expect(await BluetoothLE.scan({ signal })).toEqual([]);
    expect(fake.stopCalls()).toBe(0);
  });

  it('stopScan() ends a scan that has no time limit', async () => {
    fakeNative();
    const p = BluetoothLE.scan({ timeoutMs: 0 });
    await BluetoothLE.stopScan();
    expect(await p).toEqual([]);
  });

  it.each([
    ['[E_PERMISSION] The BLUETOOTH_SCAN permission is not granted', 'E_PERMISSION'],
    ['[E_BLUETOOTH_OFF] Bluetooth is off', 'E_BLUETOOTH_OFF'],
    ['[E_SCAN_FAILED] Scan failed: internal error', 'E_SCAN_FAILED'],
    ['something without a code', 'E_SCAN_FAILED'],
  ])('maps the native scan error "%s" to %s', async (message, code) => {
    fakeNative({ scanImpl: async () => { throw new Error(message); } });
    await expect(BluetoothLE.scan()).rejects.toMatchObject({ name: 'TransportError', code });
  });

  it('throws UnsupportedPlatformError without the native object', async () => {
    setBluetoothLE(null);
    await expect(BluetoothLE.scan()).rejects.toMatchObject({ name: 'UnsupportedPlatformError' });
    expect(BluetoothLE.isSupported()).toBe(false);
  });
});

describe('BluetoothLE filters, state and permissions', () => {
  const dev = (o: Partial<BleDevice>): BleDevice => ({
    id: 'x', name: null, rssi: null, connectable: true, serviceUuids: [], manufacturerData: null, txPower: null, ...o,
  });

  it('builds filters', () => {
    expect(bleFilters.name('lp 46')(dev({ name: 'TVSE LP 46 Dlite_1' }))).toBe(true);
    expect(bleFilters.name(/^abc/)(dev({ name: 'xabc' }))).toBe(false);
    expect(bleFilters.name('a')(dev({ name: null }))).toBe(false);
    expect(bleFilters.serviceUuid('abcd')(dev({ serviceUuids: ['0000abcd-0000-1000-8000-00805f9b34fb'] }))).toBe(true);
    expect(bleFilters.manufacturerData('4c00')(dev({ manufacturerData: '4c0012' }))).toBe(true);
    expect(bleFilters.minRssi(-70)(dev({ rssi: -60 }))).toBe(true);
    expect(bleFilters.minRssi(-70)(dev({ rssi: null }))).toBe(false);
    expect(bleFilters.all(bleFilters.name('a'), bleFilters.minRssi(-50))(dev({ name: 'a', rssi: -60 }))).toBe(false);
    expect(bleFilters.any(bleFilters.name('a'), bleFilters.minRssi(-50))(dev({ name: 'a', rssi: -60 }))).toBe(true);
  });

  it('matches a profile that the caller made', () => {
    const profile = { name: 'mine', protocol: 'BPLZ', matches: bleFilters.name('printer') };
    expect(BluetoothLE.matchProfile(dev({ name: 'My Printer' }), [profile])).toBe(profile);
    expect(BluetoothLE.matchProfile(dev({ name: 'Watch' }), [profile])).toBeUndefined();
  });

  it('reports the adapter state and state changes', () => {
    const fake = fakeNative({ state: 'off' });
    expect(BluetoothLE.getState()).toBe('off');
    const states: string[] = [];
    BluetoothLE.onStateChange((s) => states.push(s));
    fake.emitState('on');
    expect(states).toEqual(['on']);
  });

  it('asks for the Android 12 permissions', async () => {
    expect(await BluetoothLE.requestPermissions()).toBe(true);
  });
});

// ---- GATT selection ----

describe('selectCharacteristics', () => {
  it('normalizes UUIDs', () => {
    expect(normalizeUuid('180A')).toBe('0000180a-0000-1000-8000-00805f9b34fb');
    expect(normalizeUuid('0x180a')).toBe('0000180a-0000-1000-8000-00805f9b34fb');
    expect(normalizeUuid('12345678')).toBe('12345678-0000-1000-8000-00805f9b34fb');
    expect(normalizeUuid('1111111100000000000000000000ABCD')).toBe('11111111-0000-0000-0000-00000000abcd');
  });

  it('finds the serial pair with no UUID given, and in auto mode uses write without response', () => {
    const s = selectCharacteristics(serialGatt());
    expect(s.write.uuid).toBe(SERIAL_TX);
    expect(s.notify?.uuid).toBe(SERIAL_RX);
    expect(s.withResponse).toBe(false); // the characteristic has both kinds, 'auto' takes the fast one
    expect(s.alternatives).toEqual([]);
  });

  it.each([
    ['write only', { write: true }, 'auto', true],
    ['write only', { write: true }, 'write', true],
    ['without response only', { writeWithoutResponse: true }, 'auto', false],
    ['without response only', { writeWithoutResponse: true }, 'withoutResponse', false],
    ['both', { write: true, writeWithoutResponse: true }, 'auto', false],
    ['both', { write: true, writeWithoutResponse: true }, 'write', true],
    ['both', { write: true, writeWithoutResponse: true }, 'withoutResponse', false],
  ] as const)('characteristic with %s, mode %s -> withResponse=%s', (_name, props, mode, expected) => {
    const gatt = [ch(SERIAL_SVC, SERIAL_TX, { ...props })];
    expect(selectCharacteristics(gatt, { writeMode: mode }).withResponse).toBe(expected);
  });

  it('with a forced mode, skips a characteristic that lacks it and takes one that has it', () => {
    const gatt = [
      ch(SERIAL_SVC, 'only-write', { write: true }),
      ch(SERIAL_SVC, 'only-fast', { writeWithoutResponse: true }),
    ];
    expect(selectCharacteristics(gatt, { writeMode: 'write' }).write.uuid).toBe('only-write');
    expect(selectCharacteristics(gatt, { writeMode: 'withoutResponse' }).write.uuid).toBe('only-fast');
  });

  it('honors writeMode and fails when the characteristic cannot do it', () => {
    expect(selectCharacteristics(serialGatt(), { writeMode: 'withoutResponse' }).withResponse).toBe(false);
    const only = [ch(SERIAL_SVC, SERIAL_TX, { write: true })];
    expect(() => selectCharacteristics(only, { writeMode: 'withoutResponse' })).toThrow(/No writable characteristic matches/);
    const fast = [ch(SERIAL_SVC, SERIAL_TX, { writeWithoutResponse: true })];
    expect(() => selectCharacteristics(fast, { writeMode: 'write' })).toThrow(/No writable characteristic matches/);
  });

  it('skips Generic Access and Device Information, which are not printer data', () => {
    const gatt = [
      ch('1800', '2a00', { write: true }),
      ch('180a', '2a29', { write: true }),
    ];
    expect(() => selectCharacteristics(gatt)).toThrow(/No writable characteristic/);
  });

  it('lets the caller narrow by service and by characteristic, in any UUID spelling', () => {
    const gatt = [
      ch('aaaa0000-0000-0000-0000-000000000001', 'aaaa0000-0000-0000-0000-0000000000f1', { write: true }),
      ch('bbbb0000-0000-0000-0000-000000000001', 'bbbb0000-0000-0000-0000-0000000000f1', { write: true }),
      ch('bbbb0000-0000-0000-0000-000000000001', 'bbbb0000-0000-0000-0000-0000000000f2', { notify: true }),
    ];
    const s = selectCharacteristics(gatt, { serviceUuid: 'BBBB0000-0000-0000-0000-000000000001' });
    expect(s.write.uuid).toBe('bbbb0000-0000-0000-0000-0000000000f1');
    expect(s.notify?.uuid).toBe('bbbb0000-0000-0000-0000-0000000000f2');
    const t = selectCharacteristics(gatt, { writeCharacteristicUuid: 'AAAA00000000000000000000000000F1' });
    expect(t.write.uuid).toBe('aaaa0000-0000-0000-0000-0000000000f1');
  });

  it('prefers a service that has a notify partner over a lone writable characteristic', () => {
    const gatt = [
      ch('aaaa0000-0000-0000-0000-000000000001', 'aaaa0000-0000-0000-0000-0000000000f1', { write: true }),
      ...serialGatt().slice(1),
    ];
    expect(selectCharacteristics(gatt).write.uuid).toBe(SERIAL_TX);
  });

  it('reports a tie, and throws on a tie when strictSelection is set', () => {
    const gatt = [
      ch(SERIAL_SVC, 'x1', { write: true }),
      ch(SERIAL_SVC, 'x2', { write: true }),
    ];
    const s = selectCharacteristics(gatt);
    expect(s.write.uuid).toBe('x1');
    expect(s.alternatives.map((c) => c.uuid)).toEqual(['x2']);
    expect(() => selectCharacteristics(gatt, { strictSelection: true })).toThrow(/equally well/);
  });

  it('accepts a custom select() and checks its answer', () => {
    const gatt = serialGatt();
    const rx = gatt[1] as BleCharacteristic;
    const tx = gatt[2] as BleCharacteristic;
    const s = selectCharacteristics(gatt, { select: () => ({ write: tx, notify: rx }) });
    expect(s.reason).toMatch(/select/);
    expect(() => selectCharacteristics(gatt, { select: () => undefined })).toThrow(/returned no characteristic/);
    expect(() => selectCharacteristics(gatt, { select: () => ({ write: ch('q', 'z', { write: true }), notify: null }) })).toThrow(
      /does not have/
    );
  });

  it('puts the GATT table in the error so the user can choose by hand', () => {
    try {
      selectCharacteristics([ch(SERIAL_SVC, SERIAL_RX, { notify: true })]);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TransportError);
      expect((e as TransportError).code).toBe('E_NO_CHARACTERISTIC');
      expect((e as Error).message).toContain(SERIAL_RX);
      expect((e as Error).message).toContain('notify');
    }
    expect(describeGatt([])).toMatch(/no characteristics/);
  });

  it('finds an explicit notify characteristic or fails', () => {
    const s = selectCharacteristics(serialGatt(), { notifyCharacteristicUuid: SERIAL_RX });
    expect(s.notify?.uuid).toBe(SERIAL_RX);
    expect(() => selectCharacteristics(serialGatt(), { notifyCharacteristicUuid: 'nope' })).toThrow(/not found/);
  });

  it('prefers a write-only characteristic over one that can also be read (a setting) when the rest ties', () => {
    const svc = 'aaaaaaaa-0000-0000-0000-000000000001';
    const gatt = [
      ch(svc, 'cfg-readable', { read: true, write: true, writeWithoutResponse: true }),
      ch(svc, 'data-sink', { write: true, writeWithoutResponse: true }),
      ch(svc, 'rx', { notify: true }),
    ];
    const s = selectCharacteristics(gatt);
    expect(s.write.uuid).toBe('data-sink');
    expect(s.alternatives).toEqual([]);
    // A caller can still choose the other one.
    expect(selectCharacteristics(gatt, { writeCharacteristicUuid: 'cfg-readable' }).write.uuid).toBe('cfg-readable');
  });

  // The layout that a user reported for one TVS LP 46 Dlite (nRF Connect, not checked by us). It is test data only.
  it('picks the write characteristic of a serial-over-BLE module without being told its UUIDs', () => {
    const svc = '49535343-fe7d-4ae5-8fa9-9fafd205e455';
    const gatt = [
      ch('00001800-0000-1000-8000-00805f9b34fb', '00002a00-0000-1000-8000-00805f9b34fb', { read: true }),
      ch(svc, '49535343-1e4d-4bd9-ba61-23c647249616', { notify: true }),
      ch(svc, '49535343-8841-43f4-a8d4-ecbe34729bb3', { write: true, writeWithoutResponse: true }),
    ];
    const s = selectCharacteristics(gatt);
    expect(s.write.uuid).toBe('49535343-8841-43f4-a8d4-ecbe34729bb3');
    expect(s.notify?.uuid).toBe('49535343-1e4d-4bd9-ba61-23c647249616');
  });
});

// ---- error codes ----

describe('classify', () => {
  it('reads the native code in square brackets', () => {
    const e = classify(new Error('[E_AUTH] needs pairing'), 'E_WRITE');
    expect(e).toBeInstanceOf(TransportError);
    expect(e).toMatchObject({ code: 'E_AUTH', message: 'needs pairing' });
  });
  it('finds the code in an Android message with the Java class name before it and the stack after it', () => {
    const android =
      'com.margelo.nitro.bplzlabel.a: [E_BLUETOOTH_OFF] Bluetooth is off\n' +
      '  at com.margelo.nitro.bplzlabel.HybridBluetoothLE.requireAdapter(r8-map-id-6f201ba563b4d879016:38)\n' +
      '  at com.margelo.nitro.bplzlabel.HybridBluetoothLE.scan(r8-map-id-6f201ba563b4d879016:80)';
    const e = classify(new Error(android), 'E_SCAN_FAILED');
    expect(e).toMatchObject({ code: 'E_BLUETOOTH_OFF', message: 'Bluetooth is off' });
    expect(e.message).not.toContain('\n');
    expect(classify(new Error('java.lang.Error: [E_PERMISSION] The BLUETOOTH_SCAN permission is not granted'), 'E_X')).toMatchObject({
      code: 'E_PERMISSION',
      message: 'The BLUETOOTH_SCAN permission is not granted',
    });
  });
  it('shows only the first line, without the Java class name, when there is no code', () => {
    const e = classify(new Error('java.lang.IllegalStateException: boom\n  at a.b.c(d:1)'), 'E_CONNECT');
    expect(e).toMatchObject({ code: 'E_CONNECT', message: 'boom' });
  });
  it('uses the fallback when there is no code', () => {
    expect(classify(new Error('plain'), 'E_CONNECT')).toMatchObject({ code: 'E_CONNECT', message: 'plain' });
    expect(classify('text', 'E_X')).toMatchObject({ code: 'E_X' });
  });
  it('keeps a TransportError as it is', () => {
    const t = new TransportError('x', 'E_TIMEOUT');
    expect(classify(t, 'E_WRITE')).toBe(t);
  });
});

// ---- transport ----

describe('BluetoothLETransport: connect', () => {
  it('connects, asks for an MTU on Android, discovers the GATT and picks characteristics', async () => {
    const fake = fakeNative({ mtu: 185 });
    const t = new BluetoothLETransport({ id: 'dev-1' });
    const states: string[] = [];
    t.onConnectionState((e) => states.push(e.state));
    await t.connect();
    expect(fake.connectCalls).toEqual([{ id: 'dev-1', timeoutMs: 10000 }]);
    expect(fake.links[0]?.mtuRequests).toEqual([247]);
    expect(t.gatt).toHaveLength(3);
    expect(t.selection?.write.uuid).toBe(SERIAL_TX);
    expect(fake.links[0]?.subscribed).toEqual([`${SERIAL_SVC}/${SERIAL_RX}`]);
    expect(await t.isConnected()).toBe(true);
    expect(states).toEqual(['connecting', 'connected']);
    await t.disconnect();
    expect(fake.links[0]?.unsubscribed).toEqual([`${SERIAL_SVC}/${SERIAL_RX}`]);
    expect(await t.isConnected()).toBe(false);
    expect(states).toEqual(['connecting', 'connected', 'disconnecting', 'disconnected']);
  });

  it('does not ask for an MTU when requestMtu is false, and keeps going when the request fails', async () => {
    const a = fakeNative();
    await new BluetoothLETransport('dev-1', { requestMtu: false }).connect();
    expect(a.links[0]?.mtuRequests).toEqual([]);

    const b = fakeNative({ requestMtuImpl: async () => { throw new Error('[E_TIMEOUT] no answer'); } });
    const t = new BluetoothLETransport('dev-1', { requestMtu: 100 });
    await t.connect();
    expect(b.links[0]?.mtuRequests).toEqual([100]);
    expect(await t.isConnected()).toBe(true);
  });

  it('can connect without notifications', async () => {
    const fake = fakeNative();
    await new BluetoothLETransport('dev-1', { subscribe: false }).connect();
    expect(fake.links[0]?.subscribed).toEqual([]);
  });

  it('still connects when notifications fail, and prints', async () => {
    const fake = fakeNative();
    const t = new BluetoothLETransport('dev-1');
    // Break subscribe on the next link.
    const mod = (await import('../src/native')).getBluetoothLE() as NativeBluetoothLE;
    const realConnect = mod.connect.bind(mod);
    (mod as unknown as { connect: unknown }).connect = async (...a: Parameters<NativeBluetoothLE['connect']>) => {
      const link = await realConnect(...a);
      (link as unknown as { subscribe: unknown }).subscribe = async () => { throw new Error('[E_NOTIFY] no cccd'); };
      return link;
    };
    await t.connect();
    await t.write(Uint8Array.of(1, 2, 3));
    expect(fake.links[0]?.writes).toHaveLength(1);
  });

  it('cleans up and reports the code when discovery finds nothing to write to', async () => {
    const fake = fakeNative({ gatt: [ch(SERIAL_SVC, SERIAL_RX, { notify: true })] });
    const t = new BluetoothLETransport('dev-1');
    await expect(t.connect()).rejects.toMatchObject({ code: 'E_NO_CHARACTERISTIC' });
    expect(fake.links[0]?.disconnects).toBe(1);
    expect(t.connectionState).toBe('disconnected');
    expect(t.selection).toBeNull();
  });

  it('closes the link when discovery fails, and the error is retryable', async () => {
    const fake = fakeNative({ discoverImpl: async () => { throw new Error('[E_DISCOVERY] status 133'); } });
    await expect(new BluetoothLETransport('dev-1').connect()).rejects.toMatchObject({ code: 'E_DISCOVERY' });
    expect(fake.links[0]?.disconnects).toBe(1);
  });

  it.each([
    ['[E_PERMISSION] The BLUETOOTH_CONNECT permission is not granted', 'E_PERMISSION'],
    ['[E_BLUETOOTH_OFF] Bluetooth is off', 'E_BLUETOOTH_OFF'],
    ['[E_TIMEOUT] No answer from AA after 10000 ms', 'E_TIMEOUT'],
    ['[E_BAD_ADDRESS] Bad Bluetooth address: zz', 'E_BAD_ADDRESS'],
    ['[E_CONNECT] Cannot connect: GATT status 133', 'E_CONNECT'],
    ['an unknown failure', 'E_CONNECT'],
  ])('maps the native connect error "%s" to %s', async (message, code) => {
    fakeNative({ connectError: new Error(message) });
    const t = new BluetoothLETransport('dev-1');
    await expect(t.connect()).rejects.toMatchObject({ name: 'TransportError', code });
    expect(t.connectionState).toBe('disconnected');
  });

  it('passes its connect timeout to the native side', async () => {
    const fake = fakeNative();
    await new BluetoothLETransport('dev-1', { connectTimeoutMs: 1234 }).connect();
    expect(fake.connectCalls[0]?.timeoutMs).toBe(1234);
  });

  it('options win over the profile', async () => {
    const fake = fakeNative({ gatt: [...serialGatt()] });
    const profile = { writeMode: 'withoutResponse' as const, chunkSize: 5, requestMtu: false as const };
    const t = new BluetoothLETransport('dev-1', { profile, chunkSize: 7 });
    await t.connect();
    expect(fake.links[0]?.mtuRequests).toEqual([]);
    expect(t.selection?.withResponse).toBe(false);
    expect(t.payloadSize).toBe(7);
  });
});

describe('BluetoothLETransport: write', () => {
  it('splits by the link limit and keeps every byte in order', async () => {
    const fake = fakeNative({ mtu: 185 }); // 182 bytes per write
    const t = new BluetoothLETransport('dev-1');
    await t.connect();
    const data = bytes(1000);
    await t.write(data);
    const sent = fake.links[0]?.writes ?? [];
    expect(sent.map((w) => w.bytes.length)).toEqual([182, 182, 182, 182, 182, 90]);
    expect(sent.flatMap((w) => w.bytes)).toEqual(Array.from(data));
    expect(sent.every((w) => w.s === SERIAL_SVC && w.c === SERIAL_TX && !w.withResponse)).toBe(true);
  });

  it('sends a 50 KB job with nothing lost and never two writes at once', async () => {
    const fake = fakeNative({ mtu: 247 });
    const t = new BluetoothLETransport('dev-1', { chunkDelayMs: 0 });
    await t.connect();
    const data = bytes(50 * 1024, 7);
    const progress: number[] = [];
    await t.write(data, { onProgress: (sent) => progress.push(sent) });
    const sent = fake.links[0]?.writes ?? [];
    expect(sent).toHaveLength(Math.ceil((50 * 1024) / 244));
    expect(sent.flatMap((w) => w.bytes)).toEqual(Array.from(data));
    expect(fake.links[0]?.maxInFlight).toBe(1);
    expect(progress[progress.length - 1]).toBe(50 * 1024);
  });

  it('uses 20-byte pieces when the link reports nothing useful', async () => {
    const fake = fakeNative({ maxWrite: () => 0 });
    const t = new BluetoothLETransport('dev-1');
    await t.connect();
    await t.write(bytes(45));
    expect(fake.links[0]?.writes.map((w) => w.bytes.length)).toEqual([20, 20, 5]);
  });

  it('follows the MTU the device agreed to (a lower one than asked)', async () => {
    const fake = fakeNative({ mtu: 23 });
    const t = new BluetoothLETransport('dev-1');
    await t.connect();
    expect(t.payloadSize).toBe(20);
    await t.write(bytes(41));
    expect(fake.links[0]?.writes).toHaveLength(3);
  });

  it('caps pieces at chunkSize and asks the link for the right write type', async () => {
    const asked: boolean[] = [];
    const fake = fakeNative({ mtu: 247, maxWrite: (r) => { asked.push(r); return r ? 100 : 244; } });
    const t = new BluetoothLETransport('dev-1', { chunkSize: 64, writeMode: 'withoutResponse' });
    await t.connect();
    expect(t.payloadSize).toBe(64);
    await t.write(bytes(130));
    expect(asked).toContain(false);
    expect(fake.links[0]?.writes.map((w) => [w.bytes.length, w.withResponse])).toEqual([[64, false], [64, false], [2, false]]);
  });

  it('keeps binary data exact, also bytes that look like text or zero', async () => {
    const fake = fakeNative({ mtu: 23 });
    const t = new BluetoothLETransport('dev-1');
    await t.connect();
    const data = Uint8Array.from([0, 255, 0x7e, 0x5e, 0x0d, 0x0a, 0x80, 0xff, 0x00, 0x1b]);
    await t.write(data.subarray(1, 9)); // a view into a bigger buffer
    expect(fake.links[0]?.writes.flatMap((w) => w.bytes)).toEqual(Array.from(data.subarray(1, 9)));
  });

  it('waits between pieces when chunkDelayMs is set, and by default only for writes without response', async () => {
    const stamps: number[] = [];
    fakeNative({ mtu: 23, writeImpl: async () => { stamps.push(Date.now()); } });
    const t = new BluetoothLETransport('dev-1', { chunkDelayMs: 25, writeMode: 'write' });
    await t.connect();
    await t.write(bytes(60));
    expect(stamps).toHaveLength(3);
    expect((stamps[2] ?? 0) - (stamps[0] ?? 0)).toBeGreaterThanOrEqual(45);

    const stamps2: number[] = [];
    fakeNative({ mtu: 23, writeImpl: async () => { stamps2.push(Date.now()); } });
    const u = new BluetoothLETransport('dev-1'); // auto = without response: 10 ms default
    await u.connect();
    await u.write(bytes(60));
    expect((stamps2[2] ?? 0) - (stamps2[0] ?? 0)).toBeGreaterThanOrEqual(15); // 2 x 10 ms default
  });

  it('does nothing for an empty write', async () => {
    const fake = fakeNative();
    const t = new BluetoothLETransport('dev-1');
    await t.connect();
    await t.write(new Uint8Array(0));
    expect(fake.links[0]?.writes).toEqual([]);
  });

  it('refuses to write when not connected', async () => {
    fakeNative();
    await expect(new BluetoothLETransport('dev-1').write(Uint8Array.of(1))).rejects.toMatchObject({ code: 'E_NOT_CONNECTED' });
  });

  it('keeps two concurrent writes apart, byte for byte', async () => {
    const fake = fakeNative({ mtu: 23 });
    const t = new BluetoothLETransport('dev-1');
    await t.connect();
    const a = new Uint8Array(100).fill(0xaa);
    const b = new Uint8Array(100).fill(0xbb);
    await Promise.all([t.write(a), t.write(b)]);
    const all = fake.links[0]?.writes.flatMap((w) => w.bytes) ?? [];
    expect(all.slice(0, 100).every((x) => x === 0xaa)).toBe(true);
    expect(all.slice(100).every((x) => x === 0xbb)).toBe(true);
    expect(fake.links[0]?.maxInFlight).toBe(1);
  });

  it('reports how many bytes went out when a piece fails, and keeps the native code', async () => {
    fakeNative({
      mtu: 23,
      writeImpl: async (i) => { if (i === 2) throw new Error('[E_WRITE] Write failed: GATT status 133'); },
    });
    const t = new BluetoothLETransport('dev-1');
    await t.connect();
    await expect(t.write(bytes(100))).rejects.toMatchObject({ code: 'E_WRITE', message: expect.stringContaining('40 of 100 bytes') });
  });

  it('maps a pairing error to E_AUTH, which is not retried', async () => {
    fakeNative({ writeImpl: async () => { throw new Error('[E_AUTH] The device needs pairing'); } });
    const t = new BluetoothLETransport('dev-1');
    await t.connect();
    await expect(t.write(bytes(5))).rejects.toMatchObject({ code: 'E_AUTH' });
  });

  it('times out when a native write never finishes', async () => {
    fakeNative({ writeImpl: () => new Promise<void>(() => undefined) });
    const t = new BluetoothLETransport('dev-1', { writeTimeoutMs: 20 });
    await t.connect();
    const started = Date.now();
    await expect(t.write(bytes(5))).rejects.toMatchObject({ code: 'E_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('passes the write timeout to the native side', async () => {
    const fake = fakeNative();
    const t = new BluetoothLETransport('dev-1', { writeTimeoutMs: 777 });
    await t.connect();
    await t.write(bytes(3));
    expect(fake.links[0]?.writes[0]?.timeoutMs).toBe(777);
  });

  it('can be cancelled between pieces', async () => {
    const fake = fakeNative({ mtu: 23 });
    const t = new BluetoothLETransport('dev-1');
    await t.connect();
    const job = t.write(bytes(200), { onProgress: (sent) => { if (sent >= 40) t.cancel(); } });
    await expect(job).rejects.toMatchObject({ code: 'E_CANCELLED' });
    expect((fake.links[0]?.writes.length ?? 0)).toBeLessThan(10);
    // A cancel closes the link: the printer may hold half a job. The next write needs a new link.
    expect(await t.isConnected()).toBe(false);
    await expect(t.write(bytes(5))).rejects.toMatchObject({ code: 'E_NOT_CONNECTED' });
    await t.connect();
    await t.write(bytes(5));
  });

  it('can be cancelled with an AbortSignal', async () => {
    fakeNative({ mtu: 23 });
    const t = new BluetoothLETransport('dev-1');
    await t.connect();
    const signal = { aborted: true, addEventListener: () => undefined, removeEventListener: () => undefined };
    await expect(t.write(bytes(50), { signal })).rejects.toMatchObject({ code: 'E_CANCELLED' });
  });
});

describe('BluetoothLETransport: rediscover (iOS id changed)', () => {
  const emitAll = (...rows: BleScanResult[]) => async (_o: BleScanOptions, emit: (r: BleScanResult) => void) => rows.forEach(emit);
  const saved = { id: 'old', name: 'Printer-1', serviceUuids: ['svc'] };

  it('does not scan by default: an unknown id is E_DEVICE_NOT_FOUND', async () => {
    const fake = fakeNative({ unknownIds: ['old'], scanImpl: emitAll(scanResult('new', 'Printer-1')) });
    const t = new BluetoothLETransport(saved);
    await expect(t.connect()).rejects.toMatchObject({ code: 'E_DEVICE_NOT_FOUND', nothingSent: true });
    expect(fake.connectCalls.map((c) => c.id)).toEqual(['old']);
  });

  it('scans with the saved services, connects to the one device with the saved name and keeps its id', async () => {
    let filter: string[] = [];
    const fake = fakeNative({
      unknownIds: ['old'],
      scanImpl: async (o, emit) => {
        filter = o.serviceUuids;
        emit(scanResult('other', 'Printer-2'));
        emit(scanResult('new', 'Printer-1'));
      },
    });
    const t = new BluetoothLETransport(saved, { rediscover: true });
    await t.connect();
    expect(filter).toEqual(['svc']);
    expect(fake.connectCalls.map((c) => c.id)).toEqual(['old', 'new']);
    expect(t.id).toBe('new');
  });

  it('does not scan when the phone knows the id', async () => {
    const fake = fakeNative({ scanImpl: emitAll(scanResult('new', 'Printer-1')) });
    const t = new BluetoothLETransport(saved, { rediscover: true });
    await t.connect();
    expect(fake.connectCalls.map((c) => c.id)).toEqual(['old']);
    expect(t.id).toBe('old');
  });

  it('refuses two devices with the saved name (a label must not print on the wrong printer)', async () => {
    const fake = fakeNative({ unknownIds: ['old'], scanImpl: emitAll(scanResult('a', 'Printer-1'), scanResult('b', 'Printer-1')) });
    await expect(new BluetoothLETransport(saved, { rediscover: true }).connect()).rejects.toMatchObject({ code: 'E_DEVICE_NOT_FOUND' });
    expect(fake.connectCalls.map((c) => c.id)).toEqual(['old']);
  });

  it('fails with E_DEVICE_NOT_FOUND when nothing fits, and does nothing for an id string or a device with no name and no services', async () => {
    const fake = fakeNative({ unknownIds: ['old'], scanImpl: emitAll(scanResult('x', 'Printer-9')) });
    await expect(new BluetoothLETransport(saved, { rediscover: true }).connect()).rejects.toMatchObject({ code: 'E_DEVICE_NOT_FOUND' });
    await expect(new BluetoothLETransport('old', { rediscover: true }).connect()).rejects.toMatchObject({ code: 'E_DEVICE_NOT_FOUND' });
    await expect(new BluetoothLETransport({ id: 'old', name: null, serviceUuids: [] }, { rediscover: true }).connect()).rejects.toMatchObject({ code: 'E_DEVICE_NOT_FOUND' });
    expect(fake.connectCalls.map((c) => c.id)).toEqual(['old', 'old', 'old']);
  });
});

describe('BluetoothLETransport: link loss and reconnect', () => {
  it('reports an unexpected disconnect and fails the write in progress', async () => {
    const fake = fakeNative({ mtu: 23 });
    const t = new BluetoothLETransport('dev-1');
    const events: Array<[string, string | undefined]> = [];
    t.onConnectionState((e) => events.push([e.state, e.reason]));
    await t.connect();
    const link = fake.links[0] as FakeLink;
    const job = t.write(bytes(200), { onProgress: (sent) => { if (sent === 60) link.lost('GATT status 8 (connection timeout)'); } });
    await expect(job).rejects.toMatchObject({ code: 'E_DISCONNECTED' });
    expect(await t.isConnected()).toBe(false);
    expect(events[events.length - 1]).toEqual(['disconnected', 'GATT status 8 (connection timeout)']);
    await expect(t.write(bytes(5))).rejects.toMatchObject({ code: 'E_NOT_CONNECTED' });
  });

  it('opens a new link on connect() after a loss, and on reconnect()', async () => {
    const fake = fakeNative();
    const t = new BluetoothLETransport('dev-1');
    await t.connect();
    (fake.links[0] as FakeLink).lost('out of range');
    expect(await t.isConnected()).toBe(false);
    await t.connect();
    expect(fake.links).toHaveLength(2);
    await t.write(Uint8Array.of(1));
    expect(fake.links[1]?.writes).toHaveLength(1);
    await t.reconnect();
    expect(fake.links).toHaveLength(3);
    expect(await t.isConnected()).toBe(true);
  });

  it('ignores a late disconnect callback from an old link', async () => {
    const fake = fakeNative();
    const t = new BluetoothLETransport('dev-1');
    await t.connect();
    const first = fake.links[0] as FakeLink;
    await t.connect(); // closes the first link, opens a second
    first.lost('late');
    expect(await t.isConnected()).toBe(true);
  });

  it('reports the loss when the device turns off during idle time', async () => {
    const fake = fakeNative();
    const t = new BluetoothLETransport('dev-1');
    await t.connect();
    (fake.links[0] as FakeLink).lost('the device closed the link');
    expect(t.connectionState).toBe('disconnected');
    expect(t.selection).toBeNull();
  });
});

describe('BluetoothLETransport: replies', () => {
  it('collects notification data for read()', async () => {
    const fake = fakeNative();
    const t = new BluetoothLETransport('dev-1');
    await t.connect();
    fake.links[0]?.push?.(Uint8Array.of(0x02, 0x41).buffer);
    fake.links[0]?.push?.(Uint8Array.of(0x42, 0x03).buffer);
    expect(Array.from(await t.read({ timeoutMs: 500, idleMs: 20 }))).toEqual([0x02, 0x41, 0x42, 0x03]);
  });
});

// ---- with the existing protocol layer ----

describe('LabelPrinter over Bluetooth Low Energy', () => {
  it('sends the bytes of a ZplLabel unchanged, in pieces, and reconnects after a loss', async () => {
    const fake = fakeNative({ mtu: 100 });
    const transport = new BluetoothLETransport('dev-1');
    const printer = new LabelPrinter(transport, { reconnect: { initialDelayMs: 1, maxDelayMs: 2, jitter: false } });
    const label = ZplLabel.fromMm(50, 30).text(20, 20, 'Hello', { height: 40 }).barcode128(20, 80, '12345678', { height: 70 });
    const expected = Array.from(label.toBytes());

    await printer.print(label);
    expect(fake.links[0]?.writes.flatMap((w) => w.bytes)).toEqual(expected);
    expect(fake.links[0]?.writes.every((w) => w.bytes.length <= 97)).toBe(true);

    (fake.links[0] as FakeLink).lost('out of range'); // link lost while idle
    await printer.print(label); // connects again by itself
    expect(fake.links).toHaveLength(2);
    expect(fake.links[1]?.writes.flatMap((w) => w.bytes)).toEqual(expected);
  });

  it('does not retry a connect that needs the user (permission, Bluetooth off)', async () => {
    const connect = jest.fn(async () => { throw new Error('[E_PERMISSION] The BLUETOOTH_CONNECT permission is not granted'); });
    setBluetoothLE({ connect } as unknown as NativeBluetoothLE);
    const printer = new LabelPrinter(new BluetoothLETransport('dev-1'), { reconnect: { maxAttempts: 3, initialDelayMs: 1 } });
    await expect(printer.print('^XA^XZ')).rejects.toMatchObject({ code: 'E_PERMISSION' });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('retries a connect that can work next time', async () => {
    let calls = 0;
    fakeNative();
    const mod = (await import('../src/native')).getBluetoothLE() as NativeBluetoothLE;
    const realConnect = mod.connect.bind(mod);
    (mod as unknown as { connect: unknown }).connect = async (...a: Parameters<NativeBluetoothLE['connect']>) => {
      if (++calls < 3) throw new Error('[E_CONNECT] Cannot connect: GATT status 133');
      return realConnect(...a);
    };
    const printer = new LabelPrinter(new BluetoothLETransport('dev-1'), {
      reconnect: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 2, jitter: false },
    });
    await printer.print('^XA^XZ');
    expect(calls).toBe(3);
  });
});

// ---------------------------------------------------------------------------------------
// Review round: chunking, write modes, queue, life cycle
// ---------------------------------------------------------------------------------------

import { chunkBytes } from '../src/transports/chunk';

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

const SIZES = [0, 1, 19, 20, 21, 100, 512, 513, 1024, 10 * 1024, 100 * 1024 + 7];

describe('chunkBytes (pure)', () => {
  it.each(SIZES.flatMap((n) => [20, 182, 244, 512].map((c) => [n, c] as const)))(
    '%i bytes in pieces of at most %i: joined = original, none too big, none empty',
    (n, size) => {
      const data = bytes(n, 3);
      const pieces = chunkBytes(data, size);
      expect(concat(pieces)).toEqual(data);
      expect(pieces).toHaveLength(Math.ceil(n / size));
      expect(pieces.every((p) => p.length >= 1 && p.length <= size)).toBe(true);
      // all pieces but the last are full
      expect(pieces.slice(0, -1).every((p) => p.length === size)).toBe(true);
    }
  );

  it('does not copy: pieces are views of the input', () => {
    const data = bytes(50);
    const pieces = chunkBytes(data, 20);
    expect(pieces[0]?.buffer).toBe(data.buffer);
    expect(pieces[1]?.byteOffset).toBe(20);
  });

  it('works on a view into a bigger buffer', () => {
    const big = bytes(100);
    const view = big.subarray(10, 55);
    expect(concat(chunkBytes(view, 20))).toEqual(Uint8Array.from(view));
  });

  it.each([0, -1, 1.5, NaN])('rejects the chunk size %p', (size) => {
    expect(() => chunkBytes(bytes(5), size)).toThrow(RangeError);
  });
});

describe('BluetoothLETransport: byte stream is exact for every size, at every link limit', () => {
  // ATT payload = MTU - 3. 23 -> 20, 185 -> 182, 247 -> 244, 517 -> 514 (a write with response is capped at 512 by the stack).
  it.each(
    SIZES.filter((n) => n <= 10 * 1024).flatMap((n) => [23, 185, 247].map((mtu) => [n, mtu] as const))
  )('%i bytes at MTU %i', async (n, mtu) => {
    const fake = fakeNative({ mtu });
    const t = new BluetoothLETransport('dev-1', { chunkDelayMs: 0 });
    await t.connect();
    const data = bytes(n, 11);
    await t.write(data);
    const sent = fake.links[0]?.writes ?? [];
    expect(Uint8Array.from(sent.flatMap((w) => w.bytes))).toEqual(data);
    expect(sent.every((w) => w.bytes.length >= 1 && w.bytes.length <= mtu - 3)).toBe(true);
    expect(sent).toHaveLength(Math.ceil(n / (mtu - 3)));
  });

  it('sends 100 KB + 7 bytes with nothing lost, doubled or reordered (write without response)', async () => {
    const fake = fakeNative({ mtu: 247 });
    const t = new BluetoothLETransport('dev-1', { chunkDelayMs: 0, writeMode: 'withoutResponse' });
    await t.connect();
    const data = bytes(100 * 1024 + 7, 5);
    await t.write(data);
    const sent = fake.links[0]?.writes ?? [];
    expect(Uint8Array.from(sent.flatMap((w) => w.bytes))).toEqual(data);
    expect(sent.every((w) => !w.withResponse)).toBe(true);
    expect(fake.links[0]?.maxInFlight).toBe(1);
  });

  it('sends 100 KB + 7 bytes with write with response too', async () => {
    const fake = fakeNative({ mtu: 517, maxWrite: (r) => (r ? 512 : 514) });
    const t = new BluetoothLETransport('dev-1', { chunkDelayMs: 0, writeMode: 'write' });
    await t.connect();
    const data = bytes(100 * 1024 + 7, 9);
    await t.write(data);
    const sent = fake.links[0]?.writes ?? [];
    expect(Uint8Array.from(sent.flatMap((w) => w.bytes))).toEqual(data);
    expect(sent.every((w) => w.withResponse && w.bytes.length <= 512)).toBe(true);
  });

  it('uses the limit for the chosen write type (with response is capped at 512, without is not)', async () => {
    const fake = fakeNative({ mtu: 517, maxWrite: (r) => (r ? 512 : 514) });
    const a = new BluetoothLETransport('dev-1', { writeMode: 'write' });
    await a.connect();
    expect(a.payloadSize).toBe(512);
    const b = new BluetoothLETransport('dev-1', { writeMode: 'withoutResponse' });
    await b.connect();
    expect(b.payloadSize).toBe(514);
    void fake;
  });
});

describe('BluetoothLETransport: write mode reaches the native write call', () => {
  it.each([
    ['auto', false],
    ['write', true],
    ['withoutResponse', false],
  ] as const)('mode %s on a characteristic that offers both -> withResponse=%s', async (mode, expected) => {
    const fake = fakeNative({ mtu: 100 });
    const t = new BluetoothLETransport('dev-1', { writeMode: mode, chunkDelayMs: 0 });
    await t.connect();
    await t.write(bytes(250));
    const writes = fake.links[0]?.writes ?? [];
    expect(writes.length).toBeGreaterThan(1);
    expect(writes.every((w) => w.withResponse === expected)).toBe(true);
  });

  it('auto falls back to write with response when that is all the characteristic offers', async () => {
    const fake = fakeNative({ gatt: [ch(SERIAL_SVC, SERIAL_TX, { write: true })] });
    const t = new BluetoothLETransport('dev-1');
    await t.connect();
    await t.write(bytes(30));
    expect(fake.links[0]?.writes.every((w) => w.withResponse)).toBe(true);
  });

  it('fails at connect when the forced mode does not exist', async () => {
    fakeNative({ gatt: [ch(SERIAL_SVC, SERIAL_TX, { write: true })] });
    await expect(new BluetoothLETransport('dev-1', { writeMode: 'withoutResponse' }).connect()).rejects.toMatchObject({
      code: 'E_NO_CHARACTERISTIC',
    });
  });
});

describe('BluetoothLETransport: one write at a time', () => {
  it('never starts a second native write before the first ends, even for writes without response', async () => {
    const order: string[] = [];
    const fake = fakeNative({
      mtu: 23,
      writeImpl: async (_i, b) => { order.push(`w${b[0]}`); },
    });
    const t = new BluetoothLETransport('dev-1', { writeMode: 'withoutResponse', chunkDelayMs: 0 });
    await t.connect();
    const jobs = [1, 2, 3].map((n) => t.write(new Uint8Array(60).fill(n)));
    await Promise.all(jobs);
    expect(fake.links[0]?.maxInFlight).toBe(1);
    // job 1 (3 pieces), then job 2, then job 3, in order
    expect(order).toEqual(['w1', 'w1', 'w1', 'w2', 'w2', 'w2', 'w3', 'w3', 'w3']);
  });

  it('holds 5000 pieces back and releases them one by one (no burst)', async () => {
    const fake = fakeNative({ mtu: 23 });
    const t = new BluetoothLETransport('dev-1', { writeMode: 'withoutResponse', chunkDelayMs: 0 });
    await t.connect();
    await t.write(bytes(20 * 3000));
    expect(fake.links[0]?.writes).toHaveLength(3000);
    expect(fake.links[0]?.maxInFlight).toBe(1);
  }, 20000);
});

describe('BluetoothLETransport: life cycle of a write', () => {
  const track = (t: BluetoothLETransport) => {
    const events: Array<{ state: string; reason?: string | undefined; code?: string | undefined }> = [];
    t.onConnectionState((e) => events.push({ state: e.state, reason: e.reason, code: e.error?.code }));
    return events;
  };

  it('goes connected > writing > connected when a write completes', async () => {
    fakeNative();
    const t = new BluetoothLETransport('dev-1');
    await t.connect();
    const events = track(t);
    await t.write(bytes(10));
    expect(events.map((e) => e.state)).toEqual(['writing', 'connected']);
    expect(await t.isConnected()).toBe(true);
  });

  it('goes writing > disconnected with the error when a piece fails, and closes the link', async () => {
    const fake = fakeNative({ mtu: 23, writeImpl: async (i) => { if (i === 1) throw new Error('[E_WRITE] Write failed: GATT status 133'); } });
    const t = new BluetoothLETransport('dev-1');
    await t.connect();
    const events = track(t);
    await expect(t.write(bytes(100))).rejects.toMatchObject({ code: 'E_WRITE' });
    expect(events.map((e) => e.state)).toEqual(['writing', 'disconnected']);
    expect(events[1]?.code).toBe('E_WRITE');
    expect(fake.links[0]?.disconnects).toBe(1);
    expect(await t.isConnected()).toBe(false);
  });

  it('does not send a queued job after a failed job (no half job followed by a new one)', async () => {
    const fake = fakeNative({ mtu: 23, writeImpl: async (i) => { if (i === 1) throw new Error('[E_WRITE] boom'); } });
    const t = new BluetoothLETransport('dev-1');
    await t.connect();
    const first = t.write(new Uint8Array(100).fill(1));
    const second = t.write(new Uint8Array(100).fill(2));
    await expect(first).rejects.toMatchObject({ code: 'E_WRITE' });
    await expect(second).rejects.toMatchObject({ code: 'E_NOT_CONNECTED' });
    expect((fake.links[0]?.writes ?? []).every((w) => w.bytes.every((b) => b === 1))).toBe(true);
  });

  it('closes the link on a timeout, so a late native write cannot mix with the next job', async () => {
    const fake = fakeNative({ writeImpl: () => new Promise<void>(() => undefined) });
    const t = new BluetoothLETransport('dev-1', { writeTimeoutMs: 20 });
    await t.connect();
    await expect(t.write(bytes(5))).rejects.toMatchObject({ code: 'E_TIMEOUT' });
    expect(fake.links[0]?.disconnects).toBe(1);
    expect(await t.isConnected()).toBe(false);
  });

  it('a link lost during a write is reported once, with the native reason', async () => {
    const fake = fakeNative({ mtu: 23 });
    const t = new BluetoothLETransport('dev-1');
    await t.connect();
    const events = track(t);
    const link = fake.links[0] as FakeLink;
    await expect(t.write(bytes(200), { onProgress: (s) => { if (s === 40) link.lost('the device closed the link'); } })).rejects.toMatchObject({
      code: 'E_DISCONNECTED',
    });
    expect(events.filter((e) => e.state === 'disconnected')).toEqual([{ state: 'disconnected', reason: 'the device closed the link', code: undefined }]);
  });

  it('a link lost in the middle of a write is "outcome unknown": some bytes went out, so it is not nothingSent', async () => {
    const fake = fakeNative({ mtu: 23 });
    const t = new BluetoothLETransport('dev-1');
    await t.connect();
    const link = fake.links[0] as FakeLink;
    const error = await t.write(bytes(200), { onProgress: (s) => { if (s === 40) link.lost('the app was suspended'); } }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'E_DISCONNECTED', nothingSent: false });
    expect((error as { bytesSent: number }).bytesSent).toBeGreaterThan(0);
  });

  it('a failed connect ends in disconnected with the error', async () => {
    fakeNative({ connectError: new Error('[E_BLUETOOTH_OFF] Bluetooth is off') });
    const t = new BluetoothLETransport('dev-1');
    const events = track(t);
    await expect(t.connect()).rejects.toMatchObject({ code: 'E_BLUETOOTH_OFF' });
    expect(events.map((e) => [e.state, e.code])).toEqual([['connecting', undefined], ['disconnected', 'E_BLUETOOTH_OFF']]);
  });

  it('printer disappears between jobs: the next print connects once, and a permanent failure stops after maxAttempts', async () => {
    const fake = fakeNative();
    const t = new BluetoothLETransport('dev-1');
    const printer = new LabelPrinter(t, { reconnect: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2, jitter: false } });
    await printer.print('^XA^XZ');
    (fake.links[0] as FakeLink).lost('out of range');
    // From now on the printer does not answer.
    const mod = (await import('../src/native')).getBluetoothLE() as NativeBluetoothLE;
    let tries = 0;
    (mod as unknown as { connect: unknown }).connect = async () => { tries++; throw new Error('[E_TIMEOUT] No answer after 10000 ms'); };
    await expect(printer.print('^XA^XZ')).rejects.toMatchObject({ code: 'E_TIMEOUT' });
    expect(tries).toBe(2); // not forever
  });
});

// ---------------------------------------------------------------------------------------
// Diagnostics for tests and logs
// ---------------------------------------------------------------------------------------

describe('BluetoothLETransport: diagnostics', () => {
  it('reports the link numbers after connect and the stats of the last write', async () => {
    fakeNative({ mtu: 185, noResponseCallback: 'yes' });
    const t = new BluetoothLETransport('dev-1', { writeMode: 'withoutResponse', chunkDelayMs: 3 });
    expect(t.diagnostics()).toMatchObject({ state: 'disconnected', withResponse: null, mtu: null, payloadSize: null, lastWrite: null });
    await t.connect();
    const d = t.diagnostics();
    expect(d).toMatchObject({
      state: 'connected',
      deviceId: 'dev-1',
      writeModeRequested: 'withoutResponse',
      withResponse: false,
      mtu: 185,
      mtuRequest: 'asked 247, got 185',
      payloadSize: 182,
      chunkDelayMs: 3,
      noResponseCallback: 'yes',
      writeCharacteristic: { serviceUuid: SERIAL_SVC, uuid: SERIAL_TX },
      notifyCharacteristic: { serviceUuid: SERIAL_SVC, uuid: SERIAL_RX },
    });
    expect(d.connectMs).toBeGreaterThanOrEqual(0);
    expect(d.discoverMs).toBeGreaterThanOrEqual(0);
    await t.write(bytes(400));
    expect(t.diagnostics().lastWrite).toMatchObject({
      bytes: 400, chunks: 3, payloadSize: 182, chunkDelayMs: 3, withResponse: false, sentBytes: 400, ok: true,
    });
    expect(t.diagnostics().lastWrite?.durationMs).toBeGreaterThanOrEqual(6);
  });

  it('uses the write type default delay and says when the MTU request was skipped or failed', async () => {
    fakeNative({});
    const a = new BluetoothLETransport('dev-1', { writeMode: 'write', requestMtu: false });
    await a.connect();
    expect(a.diagnostics()).toMatchObject({ withResponse: true, chunkDelayMs: 0, mtuRequest: 'skipped' });
    fakeNative({ requestMtuImpl: async () => { throw new Error('[E_WRITE] Android refused'); } });
    const b = new BluetoothLETransport('dev-1');
    await b.connect();
    expect(b.diagnostics().mtuRequest).toBe('asked 247, failed: Android refused');
    expect(b.diagnostics().chunkDelayMs).toBe(10);
  });

  it('keeps the stats of a failed write, with the code and the bytes that went out', async () => {
    fakeNative({ mtu: 23, writeImpl: async (i) => { if (i === 2) throw new Error('[E_WRITE] GATT status 133'); } });
    const t = new BluetoothLETransport('dev-1', { chunkDelayMs: 0 });
    await t.connect();
    await expect(t.write(bytes(100))).rejects.toMatchObject({ code: 'E_WRITE' });
    expect(t.diagnostics().lastWrite).toMatchObject({ ok: false, errorCode: 'E_WRITE', bytes: 100, chunks: 5, sentBytes: 40 });
    expect(t.diagnostics().state).toBe('disconnected');
  });
});

describe('BluetoothLE.requestEnable (the system "turn on Bluetooth" dialog)', () => {
  it('resolves true when the user says yes, false when the user says no', async () => {
    const yes = fakeNative({ state: 'off', enableAnswer: true });
    expect(await BluetoothLE.requestEnable()).toBe(true);
    expect(yes.enableCalls()).toBe(1);
    fakeNative({ state: 'off', enableAnswer: false });
    expect(await BluetoothLE.requestEnable()).toBe(false);
  });

  it('maps the native errors to codes (permission missing, no screen to ask on)', async () => {
    fakeNative({ enableError: new Error('com.margelo.nitro.bplzlabel.a: [E_PERMISSION] The BLUETOOTH_CONNECT permission is not granted\n  at x.y(z:1)') });
    await expect(BluetoothLE.requestEnable()).rejects.toMatchObject({ code: 'E_PERMISSION', message: 'The BLUETOOTH_CONNECT permission is not granted' });
    fakeNative({ enableError: new Error('[E_BLUETOOTH_OFF] Bluetooth is off, and there is no screen to ask on') });
    await expect(BluetoothLE.requestEnable()).rejects.toMatchObject({ code: 'E_BLUETOOTH_OFF' });
  });
});

describe('BluetoothLETransport: readGatt', () => {
  it('reads each readable characteristic, keeps going after a failed read and writes nothing', async () => {
    const fake = fakeNative({
      readImpl: async (_s, c) => {
        if (c.startsWith('00002a00')) return new TextEncoder().encode('TVS LP 46');
        throw new Error('[E_AUTH] The device needs pairing');
      },
      gatt: [
        ...serialGatt(),
        ch('0000180a-0000-1000-8000-00805f9b34fb', '00002a24-0000-1000-8000-00805f9b34fb', { read: true }),
      ],
    });
    const t = new BluetoothLETransport('dev-1');
    await t.connect();
    const rows = await t.readGatt();
    expect(rows).toHaveLength(4);
    expect(Array.from(rows[0]?.value ?? [])).toEqual(Array.from(new TextEncoder().encode('TVS LP 46')));
    expect(rows[1]?.value).toBeUndefined(); // not readable: not asked
    expect(rows[3]?.error?.code).toBe('E_AUTH');
    expect(fake.links[0]?.writes).toHaveLength(0);
    await t.disconnect();
  });

  it('rejects when not connected', async () => {
    fakeNative();
    await expect(new BluetoothLETransport('dev-1').readGatt()).rejects.toMatchObject({ code: 'E_NOT_CONNECTED' });
  });

  it('LabelPrinter.readGatt gives the rows over BLE', async () => {
    fakeNative();
    const printer = new LabelPrinter(new BluetoothLETransport('dev-1'));
    const rows = await printer.readGatt();
    expect(rows?.some((r) => r.value !== undefined)).toBe(true);
  });
});

// ---- hardening: overlap, stale events, state on LabelPrinter (from the BLE audit) ----

describe('BluetoothLETransport: a connect that is overtaken', () => {
  it('rejects, closes its link and stays disconnected when disconnect() comes while it discovers', async () => {
    let release: (() => void) | null = null;
    const fake = fakeNative({
      discoverImpl: () => new Promise((resolve) => { release = () => resolve(serialGatt()); }),
    });
    const t = new BluetoothLETransport('dev-1');
    const connecting = t.connect();
    await new Promise((r) => setTimeout(r, 5));
    await t.disconnect();
    release?.();
    await expect(connecting).rejects.toMatchObject({ code: 'E_DISCONNECTED' });
    expect(fake.links[0]?.disconnects).toBeGreaterThanOrEqual(1);
    expect(t.connectionState).toBe('disconnected');
    expect(await t.isConnected()).toBe(false);
  });

  it('an older failed connect does not wipe the link of the newer one', async () => {
    let release: (() => void) | null = null;
    let first = true;
    const fake = fakeNative({
      discoverImpl: () => {
        if (first) {
          first = false;
          return new Promise((resolve) => { release = () => resolve(serialGatt()); });
        }
        return Promise.resolve(serialGatt());
      },
    });
    const t = new BluetoothLETransport('dev-1');
    const older = t.connect();
    await new Promise((r) => setTimeout(r, 5));
    // A second connect() disconnects the first one, then opens a new link.
    const newer = t.connect();
    await new Promise((r) => setTimeout(r, 20));
    release?.();
    await expect(older).rejects.toMatchObject({ code: 'E_DISCONNECTED' });
    await newer;
    expect(t.connectionState).toBe('connected');
    expect(await t.isConnected()).toBe(true);
    expect(fake.links.length).toBe(2);
  });

  it('does not report connected when the link was lost while it opened', async () => {
    const fake = fakeNative({
      discoverImpl: async () => {
        fake.links[0]?.lost('GATT status 8');
        return serialGatt();
      },
    });
    const t = new BluetoothLETransport('dev-1');
    await expect(t.connect()).rejects.toMatchObject({ code: 'E_DISCONNECTED' });
    expect(t.connectionState).toBe('disconnected');
  });
});

describe('BluetoothLETransport: stale notifications', () => {
  it('drops a notification that an old link sends after a reconnect', async () => {
    const fake = fakeNative();
    const t = new BluetoothLETransport('dev-1');
    await t.connect();
    const oldPush = fake.links[0]?.push;
    await t.reconnect();
    oldPush?.(new Uint8Array([1, 2, 3]).buffer);
    await expect(t.read({ timeoutMs: 30, idleMs: 10 })).resolves.toHaveLength(0);
    fake.links[1]?.push?.(new Uint8Array([9]).buffer);
    await expect(t.read({ timeoutMs: 100, idleMs: 10 })).resolves.toEqual(new Uint8Array([9]));
  });
});

describe('LabelPrinter: the link state', () => {
  it('shows the transport state and its changes without a second reference to the transport', async () => {
    fakeNative();
    const transport = new BluetoothLETransport('dev-1');
    const printer = new LabelPrinter(transport);
    const seen: string[] = [];
    const off = printer.onConnectionState((e) => seen.push(e.state));
    expect(printer.connectionState).toBe('disconnected');
    await printer.connect();
    expect(printer.connectionState).toBe('connected');
    await printer.disconnect();
    off();
    expect(seen).toEqual(['connecting', 'connected', 'disconnecting', 'disconnected']);
  });

  it('says null and gives a harmless unsubscribe when the transport cannot tell', () => {
    const plain = {
      connect: async () => undefined,
      disconnect: async () => undefined,
      isConnected: async () => false,
      write: async () => undefined,
      read: async () => new Uint8Array(),
    };
    const printer = new LabelPrinter(plain);
    expect(printer.connectionState).toBeNull();
    expect(() => printer.onConnectionState(() => undefined)()).not.toThrow();
    expect(() => printer.cancel()).not.toThrow();
  });
});

describe('BluetoothLETransport: what a failed write says it sent', () => {
  it('reports the bytes sent and that a native write began', async () => {
    fakeNative({ mtu: 23, writeImpl: async (index) => { if (index === 1) throw new Error('[E_WRITE] status 133'); } });
    const t = new BluetoothLETransport('dev-1');
    await t.connect();
    const error = await t.write(bytes(60)).catch((e: TransportError) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).bytesSent).toBe(20);
    expect((error as TransportError).nothingSent).toBe(false);
  });

  it('says nothing was sent when the link is found dead at the first piece', async () => {
    const fake = fakeNative();
    const t = new BluetoothLETransport('dev-1');
    await t.connect();
    const write = t.write(bytes(30));
    if (fake.links[0]) fake.links[0].connected = false; // the link died silently: no event came, the first check finds it
    const error = await write.catch((e: TransportError) => e);
    expect((error as TransportError).nothingSent).toBe(true);
    expect((error as TransportError).bytesSent).toBe(0);
  });
});

// ---- soak: many cycles with random failures (from the BLE bug research: reconnection and timing are the top IoT bug causes) ----

describe('BluetoothLETransport: soak (150 cycles of connect, print, disconnect, with random failures)', () => {
  it('always recovers, never leaves a link open, and leaks no listeners', async () => {
    let seed = 12345;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    let failNext = false;
    const fake = fakeNative({
      mtu: 185,
      writeImpl: async () => {
        if (failNext && random() < 0.5) throw new Error('[E_WRITE] status 133');
      },
      discoverImpl: async () => {
        if (failNext && random() < 0.2) throw new Error('[E_DISCOVERY] status 133');
        return serialGatt();
      },
    });
    const t = new BluetoothLETransport('dev-1');
    const states: string[] = [];
    const off = t.onConnectionState((e) => states.push(e.state));
    let printed = 0;
    let failed = 0;
    for (let cycle = 0; cycle < 150; cycle++) {
      failNext = random() < 0.4;
      try {
        await t.connect();
        await t.write(bytes(300, cycle));
        printed++;
      } catch {
        failed++;
      }
      await t.disconnect();
      expect(await t.isConnected()).toBe(false);
    }
    expect(printed).toBeGreaterThan(40);
    expect(failed).toBeGreaterThan(10);
    // Every link that was opened is closed again.
    expect(fake.links.every((l) => !l.connected)).toBe(true);
    expect(fake.links.every((l) => l.disconnects >= 1)).toBe(true);
    // One more clean cycle after all the failures.
    failNext = false;
    await t.connect();
    await t.write(bytes(10));
    expect(t.connectionState).toBe('connected');
    off();
    await t.disconnect();
    expect(t.connectionState).toBe('disconnected');
  });
});


// ---- bonding (pairing): only when the device asks, once for each connection, then the operation again ----

describe('BluetoothLETransport: bonding', () => {
  const auth = () => new Error('[E_AUTH] The device needs pairing (GATT status 5). Accept the system pairing dialog, then try again.');

  it('pairs when the first piece is refused for pairing, then sends the same piece again, once', async () => {
    let first = true;
    const fake = fakeNative({ mtu: 23, writeImpl: async () => { if (first) { first = false; throw auth(); } } });
    const t = new BluetoothLETransport('dev-1');
    await t.connect();
    await t.write(bytes(25));
    const link = fake.links[0];
    expect(link?.bonds).toBe(1);
    // 25 bytes in pieces of 20: the refused piece is sent again, so 3 writes reach the link (refused, 20, 5).
    expect(link?.writes.map((w) => w.bytes.length)).toEqual([20, 20, 5]);
    expect(t.connectionState).toBe('connected');
  });

  it('does not pair again on the same connection when the device refuses a second time', async () => {
    const fake = fakeNative({ writeImpl: async () => { throw auth(); } });
    const t = new BluetoothLETransport('dev-1');
    await t.connect();
    const error = await t.write(bytes(10)).catch((e: TransportError) => e);
    expect((error as TransportError).code).toBe('E_AUTH');
    expect(fake.links[0]?.bonds).toBe(1);
  });

  it('says E_AUTH, with nothing sent, when the person does not accept the pairing', async () => {
    const fake = fakeNative({ writeImpl: async () => { throw auth(); }, bondImpl: async () => false });
    const t = new BluetoothLETransport('dev-1');
    await t.connect();
    const error = (await t.write(bytes(10)).catch((e: TransportError) => e)) as TransportError;
    expect(error.code).toBe('E_AUTH');
    expect(error.nothingSent).toBe(true);
    expect(fake.links[0]?.bonds).toBe(1);
  });

  it('names a stale pairing: the phone has a bond, the device refuses, and a new bond cannot help', async () => {
    fakeNative({ bondedAlready: true, writeImpl: async () => { throw auth(); } });
    const t = new BluetoothLETransport('dev-1');
    await t.connect();
    const error = (await t.write(bytes(10)).catch((e: TransportError) => e)) as TransportError;
    expect(error.code).toBe('E_AUTH');
    expect(error.message).toContain('forget the device');
  });

  it('with bond set to never, reports E_AUTH and does not pair', async () => {
    const fake = fakeNative({ writeImpl: async () => { throw auth(); } });
    const t = new BluetoothLETransport('dev-1', { bond: 'never' });
    await t.connect();
    await expect(t.write(bytes(10))).rejects.toMatchObject({ code: 'E_AUTH' });
    expect(fake.links[0]?.bonds).toBe(0);
  });

  it('pairs during connect when the notification setup needs it, and subscribes again', async () => {
    const fake = fakeNative({ subscribeImpl: async (call) => { if (call === 1) throw auth(); } });
    const t = new BluetoothLETransport('dev-1');
    await t.connect();
    const link = fake.links[0];
    expect(link?.bonds).toBe(1);
    expect(link?.subscribed).toEqual([`${SERIAL_SVC}/${SERIAL_RX}`]);
  });

  it('reports a link that closed after pairing as a lost link (the caller connects again)', async () => {
    let first = true;
    const fake = fakeNative({
      writeImpl: async () => { if (first) { first = false; throw auth(); } },
      bondImpl: async (link) => { link.connected = false; return true; },
    });
    const t = new BluetoothLETransport('dev-1');
    await t.connect();
    await expect(t.write(bytes(10))).rejects.toMatchObject({ code: 'E_DISCONNECTED' });
    expect(fake.links[0]?.bonds).toBe(1);
  });

  it('leaves other errors alone: a plain write failure never starts pairing', async () => {
    const fake = fakeNative({ writeImpl: async () => { throw new Error('[E_WRITE] status 133'); } });
    const t = new BluetoothLETransport('dev-1');
    await t.connect();
    await expect(t.write(bytes(10))).rejects.toMatchObject({ code: 'E_WRITE' });
    expect(fake.links[0]?.bonds).toBe(0);
  });

  it('shows the pairing state in the diagnostics', async () => {
    fakeNative();
    const t = new BluetoothLETransport('dev-1');
    expect(t.diagnostics().bondState).toBeNull();
    await t.connect();
    expect(t.diagnostics().bondState).toBe('none');
  });
});

describe('iOS permission wait', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const rn = require('react-native') as { Platform: { OS: string } };
  afterEach(() => { rn.Platform.OS = 'android'; });

  it('waits for the first real state, because iOS reports unknown until the user answers', async () => {
    rn.Platform.OS = 'ios';
    const fake = fakeNative({ state: 'unknown' });
    const answer = BluetoothLE.requestPermissions();
    let settled = false;
    void answer.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    fake.emitState('resetting');
    await Promise.resolve();
    expect(settled).toBe(false);
    fake.emitState('on');
    await expect(answer).resolves.toBe(true);
  });

  it('answers false when the user says no', async () => {
    rn.Platform.OS = 'ios';
    const fake = fakeNative({ state: 'unknown' });
    const answer = BluetoothLE.requestPermissions();
    fake.emitState('unauthorized');
    await expect(answer).resolves.toBe(false);
  });

  it('answers at once when the state is already known', async () => {
    rn.Platform.OS = 'ios';
    fakeNative({ state: 'off' });
    await expect(BluetoothLE.requestPermissions()).resolves.toBe(true);
    fakeNative({ state: 'unauthorized' });
    await expect(BluetoothLE.requestPermissions()).resolves.toBe(false);
  });
});
