import { PermissionsAndroid, Platform } from 'react-native';
import { TransportError, UnsupportedPlatformError } from '../errors';
import { getClassicBluetooth, toArrayBuffer } from '../native';
import type { ClassicBluetooth } from '../specs/ClassicBluetooth.nitro';
import type { ClassicConnection } from '../specs/ClassicConnection.nitro';
import type { ReadOptions, Transport } from '../transport';

export interface PairedDevice {
  name: string | null;
  address: string;
}

export interface BluetoothClassicOptions {
  /** Skip the secure socket and open the insecure one first. Default false. */
  preferInsecure?: boolean | undefined;
  /** Delay in ms between 1024-byte pieces. Default 0. Raise it if labels come out cut. */
  chunkDelayMs?: number | undefined;
  /** Stop a write after this many ms. Default 3000 (the SNBC SDK default). 0 turns it off. */
  writeTimeoutMs?: number | undefined;
}

function native(): ClassicBluetooth {
  const mod = Platform.OS === 'android' ? getClassicBluetooth() : null;
  if (!mod) {
    throw new UnsupportedPlatformError(
      'Bluetooth Classic printing works on Android only. On iOS use BluetoothLETransport (BLE printers) or TcpTransport (Ethernet or WiFi printers).'
    );
  }
  return mod;
}

/**
 * Nitro passes only the message of a Kotlin error. These messages come from
 * HybridClassicBluetooth.kt. Errors that the user must fix get their own code,
 * so the reconnect logic does not retry them.
 */
function classify(message: string, fallback: string): string {
  if (/BLUETOOTH_CONNECT permission/i.test(message)) return 'E_PERMISSION';
  if (/Bluetooth is off/i.test(message)) return 'E_BLUETOOTH_OFF';
  if (/Bad Bluetooth address/i.test(message)) return 'E_BAD_ADDRESS';
  if (/no Bluetooth adapter/i.test(message)) return 'E_NO_ADAPTER';
  return fallback;
}

async function wrap<T>(promise: Promise<T> | T, code = 'E_BLUETOOTH'): Promise<T> {
  try {
    return await promise;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new TransportError(message, classify(message, code));
  }
}

/** Helpers that do not need a connection. */
export const BluetoothClassic = {
  isSupported(): boolean {
    return Platform.OS === 'android' && getClassicBluetooth() !== null;
  },

  /** Ask for the Android 12+ BLUETOOTH_CONNECT permission. Returns true when granted. */
  async requestPermissions(): Promise<boolean> {
    if (Platform.OS !== 'android') return false;
    if (typeof Platform.Version === 'number' && Platform.Version < 31) return true;
    const result = await PermissionsAndroid.request('android.permission.BLUETOOTH_CONNECT');
    return result === PermissionsAndroid.RESULTS.GRANTED;
  },

  isEnabled(): boolean {
    return native().isEnabled();
  },

  /** Printers paired in the phone's Bluetooth settings. This library does not scan. */
  async getPairedDevices(): Promise<PairedDevice[]> {
    const list = await wrap(native().getBondedDevices());
    return list.map((d) => ({ name: d.name === '' ? null : d.name, address: d.address }));
  },
};

/**
 * Bluetooth Classic (RFCOMM / SPP) link to a paired printer. Android only.
 * The printer must be paired in the phone's Bluetooth settings first.
 * Bytes go to the native side as ArrayBuffer, with no base64 step.
 */
export class BluetoothClassicTransport implements Transport {
  private connection: ClassicConnection | null = null;

  constructor(
    private readonly address: string,
    private readonly options: BluetoothClassicOptions = {}
  ) {}

  /** Counts connects and disconnects: a connect that finishes after a `disconnect()` must close its socket (BLE does the same). */
  private generation = 0;

  async connect(): Promise<void> {
    await this.disconnect();
    const gen = this.generation;
    const connection = await wrap(native().connect(this.address, !!this.options.preferInsecure), 'E_CONNECT');
    if (gen !== this.generation) {
      // `disconnect()` (or `dispose()`) came while the socket opened. A printer that takes one connection must not stay held.
      await wrap(connection.close()).catch(() => undefined);
      throw new TransportError('The connection was closed while it opened', 'E_CANCELLED');
    }
    this.connection = connection;
  }

  async disconnect(): Promise<void> {
    this.generation++;
    const c = this.connection;
    this.connection = null;
    if (c) await wrap(c.close());
  }

  async isConnected(): Promise<boolean> {
    return this.connection?.isConnected ?? false;
  }

  async write(data: Uint8Array): Promise<void> {
    const c = this.need();
    const delay = this.options.chunkDelayMs ?? 0;
    const pieces = Math.max(1, Math.ceil(data.length / 1024));
    const limit = this.options.writeTimeoutMs ?? 3000;
    // The limit counts per 1024-byte piece, so a big label with a chunk delay is not cut off.
    const budget = limit > 0 ? limit + (pieces - 1) * delay + pieces * limit : 0;
    const job = wrap(c.write(toArrayBuffer(data), delay), 'E_WRITE');
    if (budget === 0) {
      await job;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TransportError('Write timed out', 'E_TIMEOUT')), budget);
    });
    try {
      await Promise.race([job, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async read(options: ReadOptions = {}): Promise<Uint8Array> {
    const c = this.need();
    const buffer = await wrap(c.read(options.timeoutMs ?? 1500, options.idleMs ?? 150, options.maxBytes ?? 0), 'E_READ');
    return new Uint8Array(buffer);
  }

  private need(): ClassicConnection {
    if (!this.connection) throw new TransportError('Not connected', 'E_NOT_CONNECTED');
    return this.connection;
  }
}
