import { PermissionsAndroid, Platform } from 'react-native';
import type { BleConnection } from '../specs/BleConnection.nitro';
import { getBluetoothLE } from '../native';
import { native, toDevice, wrap } from './bleCommon';
import type {
  BleAdapterState,
  BleConnectOptions,
  BleDevice,
  BluetoothLEScanOptions,
  BlePrinterProfile,
} from './bleTypes';
import { describeGatt, normalizeUuid as normalize, type BleGattCharacteristic } from './bleGatt';


/** Small building blocks for `BluetoothLEScanOptions.filter`. The package does not pick printers for you. */
export const bleFilters = {
  /** Name contains the text (case does not matter), or matches the RegExp. */
  name(pattern: string | RegExp): (d: BleDevice) => boolean {
    return (d) => {
      if (d.name === null) return false;
      return typeof pattern === 'string' ? d.name.toLowerCase().includes(pattern.toLowerCase()) : pattern.test(d.name);
    };
  },
  /** The advertisement lists this service. */
  serviceUuid(uuid: string): (d: BleDevice) => boolean {
    const wanted = normalize(uuid);
    return (d) => d.serviceUuids.some((s) => normalize(s) === wanted);
  },
  /** The manufacturer data starts with these hex bytes (the company id comes first, little endian). */
  manufacturerData(prefixHex: string): (d: BleDevice) => boolean {
    const wanted = prefixHex.toLowerCase();
    return (d) => d.manufacturerData?.startsWith(wanted) ?? false;
  },
  /** RSSI is at least this value (dBm). Devices without RSSI do not pass. */
  minRssi(dbm: number): (d: BleDevice) => boolean {
    return (d) => d.rssi !== null && d.rssi >= dbm;
  },
  all(...filters: Array<(d: BleDevice) => boolean>): (d: BleDevice) => boolean {
    return (d) => filters.every((f) => f(d));
  },
  any(...filters: Array<(d: BleDevice) => boolean>): (d: BleDevice) => boolean {
    return (d) => filters.some((f) => f(d));
  },
};

// ---------------------------------------------------------------------------------------
// BluetoothLE: scan and connect
// ---------------------------------------------------------------------------------------

/** An open GATT link from `BluetoothLE.connect()`. Use it to look at the GATT table. */
export class BleDeviceConnection {
  constructor(
    private readonly link: BleConnection,
    private readonly disconnectListeners: Set<(reason: string) => void>
  ) {}

  get id(): string {
    return this.link.id;
  }

  get isConnected(): boolean {
    return this.link.isConnected;
  }

  /** The agreed MTU, or an estimate on iOS (largest write without response + 3). */
  get mtu(): number {
    return this.link.mtu;
  }

  /** All services and characteristics, with their properties. */
  discover(): Promise<BleGattCharacteristic[]> {
    return wrap(this.link.discover(), 'E_DISCOVERY');
  }

  /** The GATT table as text. */
  async describe(): Promise<string> {
    return describeGatt(await this.discover());
  }

  /** Called once when the link closes, also after `disconnect()`. Returns a function that removes the listener. */
  onDisconnect(listener: (reason: string) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  disconnect(): Promise<void> {
    return wrap(this.link.disconnect(), 'E_DISCONNECTED');
  }
}

const stateListeners = new Set<(state: BleAdapterState) => void>();
/** The native object that holds our one state listener (a new object, as in tests, needs the listener again). */
let stateHookedOn: unknown = null;

/** Scan for and connect to Bluetooth Low Energy devices. It knows nothing about printers. */
/** How long to wait for the person to answer the iOS Bluetooth dialog. */
const IOS_DIALOG_WAIT_MS = 60_000;

/**
 * iOS: the first `getState()` creates the central manager, which shows the permission dialog. The state stays `unknown`
 * (or `resetting`) until the user answers, so wait for the first real state. Apple: CBManager.authorization and
 * centralManagerDidUpdateState. Not compiled or run on iOS.
 */
function askIosAuthorization(): Promise<boolean> {
  const first = BluetoothLE.getState();
  if (first !== 'unknown' && first !== 'resetting') return Promise.resolve(first !== 'unauthorized');
  return new Promise<boolean>((resolve) => {
    let off: (() => void) | undefined;
    let finished = false;
    const done = (allowed: boolean) => {
      finished = true;
      clearTimeout(timer);
      off?.();
      resolve(allowed);
    };
    const timer = setTimeout(() => done(BluetoothLE.getState() !== 'unauthorized'), IOS_DIALOG_WAIT_MS);
    off = BluetoothLE.onStateChange((state) => {
      if (state !== 'unknown' && state !== 'resetting') done(state !== 'unauthorized');
    });
    if (finished) off();
  });
}

export const BluetoothLE = {
  isSupported(): boolean {
    return getBluetoothLE() !== null;
  },

  /**
   * Ask for the runtime permissions. Android 12+: BLUETOOTH_SCAN and BLUETOOTH_CONNECT.
   * Android 11 and older: ACCESS_FINE_LOCATION (Android needs it to scan; the library does not read your location).
   * iOS: reading the state starts the system dialog the first time, and this waits until the user has answered
   * (CoreBluetooth reports `unknown` until then). Returns true when allowed.
   */
  async requestPermissions(): Promise<boolean> {
    if (Platform.OS !== 'android') return askIosAuthorization();
    const permissions =
      typeof Platform.Version === 'number' && Platform.Version >= 31
        ? ['android.permission.BLUETOOTH_SCAN', 'android.permission.BLUETOOTH_CONNECT']
        : ['android.permission.ACCESS_FINE_LOCATION'];
    const result = await PermissionsAndroid.requestMultiple(permissions as Parameters<typeof PermissionsAndroid.requestMultiple>[0]);
    return permissions.every((p) => (result as Record<string, string>)[p] === PermissionsAndroid.RESULTS.GRANTED);
  },

  /**
   * Show the system dialog that asks the user to turn Bluetooth on (Android: "Turn on Bluetooth?"). Resolves true when it is on,
   * false when the user said no. Ask for the permissions first (`requestPermissions()`): Android 12+ needs BLUETOOTH_CONNECT.
   * iOS has no such dialog for apps: it shows its own alert at the first use, and this resolves the current state.
   */
  async requestEnable(): Promise<boolean> {
    return wrap(native().requestEnable(), 'E_BLUETOOTH_OFF');
  },

  /** The adapter state: on, off, unauthorized, unsupported, resetting or unknown. */
  getState(): BleAdapterState {
    return native().getState() as BleAdapterState;
  },

  /** Be told when Bluetooth turns on or off, or the permission changes. Returns a function that removes the listener. */
  onStateChange(listener: (state: BleAdapterState) => void): () => void {
    const mod = native();
    stateListeners.add(listener);
    if (stateHookedOn !== mod) {
      stateHookedOn = mod;
      mod.setStateListener((s) => {
        for (const l of [...stateListeners]) l(s as BleAdapterState);
      });
    } else {
      const current = mod.getState() as BleAdapterState;
      if (current !== 'unknown') listener(current);
    }
    return () => stateListeners.delete(listener);
  },

  /**
   * Scan and return the devices found, strongest RSSI first. Rejects when the scan cannot start
   * (Bluetooth off, no permission). Does not decide what a printer is: use `filter`.
   * `stopScan()` and `signal` end the scan early. The promise then resolves with the devices found so far.
   */
  async scan(options: BluetoothLEScanOptions = {}): Promise<BleDevice[]> {
    const mod = native();
    const found = new Map<string, BleDevice>();
    const { filter, onDevice, signal } = options;
    const onAbort = () => void mod.stopScan().catch(() => undefined);
    if (signal?.aborted) return [];
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await wrap(
        mod.scan(
          {
            serviceUuids: options.serviceUuids ?? [],
            timeoutMs: options.timeoutMs ?? 5000,
            allowDuplicates: options.allowDuplicates ?? false,
          },
          (result) => {
            const device = toDevice(result);
            if (filter && !filter(device)) return;
            const isNew = !found.has(device.id);
            found.set(device.id, device);
            if (isNew) onDevice?.(device);
          }
        ),
        'E_SCAN_FAILED'
      );
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    return [...found.values()].sort((a, b) => (b.rssi ?? -Infinity) - (a.rssi ?? -Infinity));
  },

  /** End a running scan. `scan()` then resolves with what it found. */
  stopScan(): Promise<void> {
    return wrap(native().stopScan(), 'E_SCAN_FAILED');
  },

  /** Open a GATT link, for example to look at the GATT table. For printing, use `BluetoothLETransport`. */
  async connect(deviceId: string | BleDevice, options: BleConnectOptions = {}): Promise<BleDeviceConnection> {
    const listeners = new Set<(reason: string) => void>();
    const id = typeof deviceId === 'string' ? deviceId : deviceId.id;
    const link = await wrap(
      native().connect(id, options.timeoutMs ?? 10000, (reason) => {
        for (const l of [...listeners]) l(reason);
      }),
      'E_CONNECT'
    );
    return new BleDeviceConnection(link, listeners);
  },

  /** Connect, read the GATT table, disconnect. Use it to see what a device offers. */
  async inspect(deviceId: string | BleDevice, options: BleConnectOptions = {}): Promise<BleGattCharacteristic[]> {
    const connection = await BluetoothLE.connect(deviceId, options);
    try {
      return await connection.discover();
    } finally {
      await connection.disconnect().catch(() => undefined);
    }
  },

  /** The first profile whose `matches` accepts the device, or undefined. */
  matchProfile(device: BleDevice, profiles: readonly BlePrinterProfile[]): BlePrinterProfile | undefined {
    return profiles.find((p) => p.matches?.(device));
  },
};

