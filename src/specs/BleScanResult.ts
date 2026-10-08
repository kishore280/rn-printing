/**
 * One Bluetooth Low Energy device seen during a scan.
 * @see {@linkcode BluetoothLE.scan}
 */
export interface BleScanResult {
  /**
   * Stable id of the device on this phone. Pass it to `connect()`.
   * Android: the MAC address. iOS: a UUID that iOS makes for this phone (not the MAC).
   */
  id: string
  /** The name from the advertisement, or the cached device name. Empty when there is none. */
  name: string
  /** Signal strength in dBm. Missing when the platform gives no value. */
  rssi?: number
  /** True when the device accepts connections. Android 8+ and iOS tell this. Older Android says true. */
  connectable: boolean
  /** Service UUIDs in the advertisement (lower case, 128-bit form). Can be empty. */
  serviceUuids: string[]
  /** Manufacturer data as hex, with the 2-byte company id first (little endian). Empty when none. */
  manufacturerData: string
  /** TX power level from the advertisement in dBm. Missing when not sent. */
  txPower?: number
}
