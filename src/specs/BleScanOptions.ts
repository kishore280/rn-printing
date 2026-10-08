/**
 * Settings for {@linkcode BluetoothLE.scan}.
 * The platform filter is optional. Filter by name or by data in TypeScript when you need more.
 */
export interface BleScanOptions {
  /**
   * Report only devices that advertise one of these service UUIDs. An empty list reports all devices.
   * Use it when you know the service. iOS needs it for scans in the background.
   */
  serviceUuids: string[]
  /** Stop the scan after this many ms. 0 means no limit (call `stopScan()`). */
  timeoutMs: number
  /**
   * Report a device again each time it advertises (to follow the RSSI).
   * When false, each device is reported once per scan.
   */
  allowDuplicates: boolean
}
