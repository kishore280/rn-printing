import type { AbortSignalLike, LinkEvent, LinkState, WriteOptions } from '../transport';
import type { TransportError } from '../errors';
import type { BleGattCharacteristic, BleSelectionOptions, BleWriteMode } from './bleGatt';


export type BleAdapterState = 'on' | 'off' | 'unauthorized' | 'unsupported' | 'resetting' | 'unknown';

/** A device seen in a scan. Nothing here says it is a printer. */
export interface BleDevice {
  /** Pass it to `BluetoothLE.connect()` or `new BluetoothLETransport()`. Android: MAC. iOS: a UUID made by iOS. */
  id: string;
  name: string | null;
  /** dBm. null when the platform gives none. */
  rssi: number | null;
  connectable: boolean;
  /** Advertised service UUIDs, lower case, 128-bit form. */
  serviceUuids: string[];
  /** Hex of the first manufacturer block: 2-byte company id (little endian), then data. null when none. */
  manufacturerData: string | null;
  txPower: number | null;
}

export type { AbortSignalLike } from '../transport';

export interface BluetoothLEScanOptions {
  /** Ask the platform to report only devices that advertise one of these services. Default: all. */
  serviceUuids?: string[] | undefined;
  /** Stop after this many ms. Default 5000. 0 means "until stopScan() or the signal". */
  timeoutMs?: number | undefined;
  /** Keep updating the RSSI of devices already seen. Default false. */
  allowDuplicates?: boolean | undefined;
  /** Keep only devices where this returns true. Runs in TypeScript. See `bleFilters`. */
  filter?: ((device: BleDevice) => boolean) | undefined;
  /** Called at once for each new device that passes the filter. Use it to fill a list on screen. */
  onDevice?: ((device: BleDevice) => void) | undefined;
  /** Abort to stop the scan. The promise then resolves with the devices found so far. */
  signal?: AbortSignalLike | undefined;
}

export interface BleConnectOptions {
  /** Give up after this many ms. Default 10000. */
  timeoutMs?: number | undefined;
}

/**
 * Life cycle of the link and of a write:
 * `connecting` > `connected` > `writing` > `connected` (write completed) ... > `disconnecting` > `disconnected`.
 * A failed write, a timeout, a cancel and a lost link all end in `disconnected`, with `reason` and `error`.
 */
export type BleConnectionState = LinkState;

export interface BleConnectionStateEvent extends LinkEvent {
  /** The error that ended the link, when there was one (a failed write or connect). Not set for a plain disconnect or a lost link. */
  error?: TransportError | undefined;
}

/**
 * Optional description of one kind of printer. The package has none built in.
 * Make your own and pass it as `profile`, or use `matches` to find printers in a scan.
 * Settings in `BluetoothLETransportOptions` win over the profile.
 */
export interface BlePrinterProfile extends BleSelectionOptions {
  /** A label for your own use. */
  name?: string | undefined;
  /** The command language the printer speaks. The transport does not use it. */
  protocol?: 'BPLZ' | 'BPLC' | 'BPLA' | 'ZPL' | 'CPCL' | (string & {}) | undefined;
  /** Decide whether a scanned device belongs to this profile. */
  matches?: ((device: BleDevice) => boolean) | undefined;
  chunkSize?: number | undefined;
  chunkDelayMs?: number | undefined;
  requestMtu?: number | false | undefined;
}

export interface BluetoothLETransportOptions extends BleSelectionOptions {
  profile?: BlePrinterProfile | undefined;
  /**
   * Ask for this ATT MTU after connect. Android only. Default 247. `false` skips the request.
   * The device can agree to less. The transport uses the agreed value.
   */
  requestMtu?: number | false | undefined;
  /** Upper limit for one write, in bytes. The link limit still applies. Default: the link limit. */
  chunkSize?: number | undefined;
  /**
   * Wait this long between pieces, in ms. Default 0 for write with response.
   * Default 10 for write without response, because the printer cannot tell you when its buffer is full.
   * Neither default is checked on a printer.
   */
  chunkDelayMs?: number | undefined;
  /** Connect timeout in ms. Default 10000. */
  connectTimeoutMs?: number | undefined;
  /** Timeout for one write piece in ms. Default 5000. */
  writeTimeoutMs?: number | undefined;
  /** Turn on notifications for printer replies (status queries). Default true. */
  subscribe?: boolean | undefined;
  /**
   * What to do when the device wants an encrypted link (an operation fails with `E_AUTH`). `auto` (default): pair with the device once per
   * connection (Android `createBond`, the phone shows its pairing dialog), wait for the result, and do the failed operation again. `never`:
   * report `E_AUTH` and let the caller decide. iOS pairs by itself with its own dialog, so there `auto` only does the operation again.
   * Not checked on a printer: the TVS may not need pairing at all.
   */
  bond?: 'auto' | 'never' | undefined;
  /**
   * iOS only in practice. When the phone does not know the device id (`E_DEVICE_NOT_FOUND`), scan once for the name or the services of the
   * device object given to the constructor and connect to the one device that fits (`id` then gives the new id). Default false: two printers
   * with one name in range would make a label print on the wrong one, so only turn it on when one printer is in the place. Does nothing when
   * the constructor got an id string, or a device with no name and no services. Not checked on an iPhone.
   */
  rediscover?: boolean | undefined;
  /** How long to wait for the person to accept the pairing, in ms. Default 30000. */
  bondTimeoutMs?: number | undefined;
}

/** One row of the GATT table, with the value when the characteristic can be read. */
export interface BleGattReading extends BleGattCharacteristic {
  value?: Uint8Array;
  error?: { code: string; message: string };
}

/** What one `write()` did. For tests and logs. */
export interface BleWriteStats {
  bytes: number;
  /** Pieces the job was split into. */
  chunks: number;
  /** Bytes in one piece (the last one can be smaller). */
  payloadSize: number;
  chunkDelayMs: number;
  withResponse: boolean;
  /** Bytes the stack accepted before the write ended. */
  sentBytes: number;
  durationMs: number;
  ok: boolean;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
}

/** The state of the link and the numbers behind it, for tests and logs (`transport.diagnostics()`). */
export interface BleDiagnostics {
  /** `none`, `bonding`, `bonded`, or `unknown` (iOS has no such state). null when there is no link. */
  bondState: string | null;
  state: BleConnectionState;
  deviceId: string;
  /** The `writeMode` that was asked for. */
  writeModeRequested: BleWriteMode;
  /** What the transport uses: true = write with response. null when not connected. */
  withResponse: boolean | null;
  writeCharacteristic: { serviceUuid: string; uuid: string } | null;
  notifyCharacteristic: { serviceUuid: string; uuid: string } | null;
  /** The ATT MTU of the link (an estimate on iOS). null when not connected. */
  mtu: number | null;
  /** What the MTU request did: `skipped`, `asked 247, got 185`, or `asked 247, failed: ...`. */
  mtuRequest: string;
  /** Bytes in one write on this link (after `chunkSize`). null when not connected. */
  payloadSize: number | null;
  /** The wait between pieces that is used (the default of the write type, or `chunkDelayMs`). null when not connected. */
  chunkDelayMs: number | null;
  /** Android: did the first write without response get a callback (`yes`, `no`, `unknown`). iOS: `not applicable`. */
  noResponseCallback: string | null;
  connectMs: number | null;
  discoverMs: number | null;
  lastWrite: BleWriteStats | null;
}

export type BleWriteOptions = WriteOptions;

