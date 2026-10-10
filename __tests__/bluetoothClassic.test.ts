import { BluetoothClassic, BluetoothClassicTransport } from '../src/transports/bluetoothClassic';
import { setClassicBluetooth } from '../src/native';
import { TransportError } from '../src/errors';
import { ZplLabel } from '../src/zpl';
import type { ClassicBluetooth } from '../src/specs/ClassicBluetooth.nitro';
import type { ClassicConnection } from '../src/specs/ClassicConnection.nitro';

function fakeConnection() {
  const log: Array<{ bytes: number[]; delay: number }> = [];
  let closed = false;
  const conn = {
    get isConnected() { return !closed; },
    write: async (data: ArrayBuffer, delay: number) => { log.push({ bytes: Array.from(new Uint8Array(data)), delay }); },
    read: async () => Uint8Array.of(7, 8).buffer,
    close: async () => { closed = true; },
  } as unknown as ClassicConnection;
  return { conn, log };
}

describe('Bluetooth Classic over the native object', () => {
  afterEach(() => setClassicBluetooth(undefined));

  it('lists paired devices, turning an empty name into null', async () => {
    setClassicBluetooth({
      isEnabled: () => true,
      getBondedDevices: async () => [{ name: '', address: 'AA:BB:CC:DD:EE:FF' }, { name: 'LP46', address: '11:22:33:44:55:66' }],
    } as unknown as ClassicBluetooth);
    expect(BluetoothClassic.isSupported()).toBe(true);
    expect(await BluetoothClassic.getPairedDevices()).toEqual([
      { name: null, address: 'AA:BB:CC:DD:EE:FF' },
      { name: 'LP46', address: '11:22:33:44:55:66' },
    ]);
  });

  it('connects, writes bytes without base64, reads, and closes', async () => {
    const { conn, log } = fakeConnection();
    let seen: [string, boolean] | null = null;
    setClassicBluetooth({
      connect: async (a: string, p: boolean) => { seen = [a, p]; return conn; },
    } as unknown as ClassicBluetooth);
    const t = new BluetoothClassicTransport('AA:BB:CC:DD:EE:FF', { preferInsecure: true, chunkDelayMs: 5 });
    await t.connect();
    expect(seen).toEqual(['AA:BB:CC:DD:EE:FF', true]);
    expect(await t.isConnected()).toBe(true);
    await t.write(Uint8Array.from([1, 2, 3, 4]).subarray(1, 3)); // a view into a bigger buffer
    expect(log).toEqual([{ bytes: [2, 3], delay: 5 }]);
    expect(Array.from(await t.read())).toEqual([7, 8]);
    await t.disconnect();
    expect(await t.isConnected()).toBe(false);
  });

  it('turns native errors into TransportError and times out slow writes', async () => {
    const slow = { isConnected: true, write: () => new Promise(() => undefined), close: async () => undefined } as unknown as ClassicConnection;
    setClassicBluetooth({ connect: async () => slow } as unknown as ClassicBluetooth);
    const t = new BluetoothClassicTransport('AA:BB:CC:DD:EE:FF', { writeTimeoutMs: 30 });
    await t.connect();
    await expect(t.write(Uint8Array.of(1))).rejects.toMatchObject({ code: 'E_TIMEOUT' });

    setClassicBluetooth({ connect: async () => { throw new Error('nope'); } } as unknown as ClassicBluetooth);
    await expect(new BluetoothClassicTransport('AA:BB:CC:DD:EE:FF').connect()).rejects.toBeInstanceOf(TransportError);
  });

  it('refuses to write when not connected', async () => {
    await expect(new BluetoothClassicTransport('x').write(Uint8Array.of(1))).rejects.toMatchObject({ code: 'E_NOT_CONNECTED' });
  });

  it.each([
    ['The BLUETOOTH_CONNECT permission is not granted', 'E_PERMISSION'],
    ['Bluetooth is off', 'E_BLUETOOTH_OFF'],
    ['Bad Bluetooth address: xx', 'E_BAD_ADDRESS'],
    ['This phone has no Bluetooth adapter', 'E_NO_ADAPTER'],
    ['Cannot connect to AA: read failed', 'E_CONNECT'],
  ])('maps the Kotlin message "%s" to %s', async (message, code) => {
    setClassicBluetooth({ connect: async () => { throw new Error(message); } } as unknown as ClassicBluetooth);
    await expect(new BluetoothClassicTransport('AA:BB:CC:DD:EE:FF').connect()).rejects.toMatchObject({ code });
  });
});

describe('Bluetooth Classic carries any bytes (BPLZ, binary images)', () => {
  afterEach(() => setClassicBluetooth(undefined));

  it('passes all 256 byte values and a whole ZPL label to the native write, unchanged', async () => {
    const { conn, log } = fakeConnection();
    setClassicBluetooth({ connect: async () => conn } as unknown as ClassicBluetooth);
    const t = new BluetoothClassicTransport('AA:BB:CC:DD:EE:FF');
    await t.connect();
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    await t.write(all);
    const zpl = ZplLabel.fromMm(50, 30).text(20, 20, 'Hello').toBytes();
    await t.write(zpl);
    expect(log[0]?.bytes).toEqual(Array.from(all));
    expect(log[1]?.bytes).toEqual(Array.from(zpl));
  });
});

describe('Bluetooth Classic: a connect that is still opening when the printer is removed', () => {
  afterEach(() => setClassicBluetooth(undefined));

  it('closes the socket that opens later (found by an independent review: the printer stayed held)', async () => {
    const { conn } = fakeConnection();
    let open: (c: ClassicConnection) => void = () => undefined;
    setClassicBluetooth({
      connect: () => new Promise<ClassicConnection>((resolve) => { open = resolve; }),
    } as unknown as ClassicBluetooth);
    const t = new BluetoothClassicTransport('AA:BB:CC:DD:EE:FF');
    const connecting = t.connect().then(() => 'connected', (e: { code?: string }) => e.code);
    await new Promise((r) => setTimeout(r, 5));
    await t.disconnect(); // what LabelPrinter.dispose() does
    open(conn);
    expect(await connecting).toBe('E_CANCELLED');
    expect(conn.isConnected).toBe(false); // the socket was closed
    expect(await t.isConnected()).toBe(false);
  });

  it('a newer connect() also closes the socket of the older one', async () => {
    const a = fakeConnection();
    const b = fakeConnection();
    const opens: Array<(c: ClassicConnection) => void> = [];
    setClassicBluetooth({
      connect: () => new Promise<ClassicConnection>((resolve) => { opens.push(resolve); }),
    } as unknown as ClassicBluetooth);
    const t = new BluetoothClassicTransport('AA:BB:CC:DD:EE:FF');
    const first = t.connect().then(() => 'connected', (e: { code?: string }) => e.code);
    await new Promise((r) => setTimeout(r, 5));
    const second = t.connect();
    await new Promise((r) => setTimeout(r, 5));
    opens[0]?.(a.conn);
    opens[1]?.(b.conn);
    await second;
    expect(await first).toBe('E_CANCELLED');
    expect(a.conn.isConnected).toBe(false);
    expect(b.conn.isConnected).toBe(true);
  });
});
