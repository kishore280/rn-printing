import type { HybridObject } from 'react-native-nitro-modules'
import type { BleConnection } from './BleConnection.nitro'
import type { BleScanOptions } from './BleScanOptions'
import type { BleScanResult } from './BleScanResult'

/**
 * Entry point for Bluetooth Low Energy (BLE). Android uses the Android BLE API.
 * iOS uses CoreBluetooth. The object knows nothing about printers.
 *
 * Error messages from this object and from {@linkcode BleConnection} start with a
 * code in square brackets, for example `[E_BLUETOOTH_OFF] Bluetooth is off`.
 * `src/transports/bluetoothLE.ts` reads the code.
 */
export interface BluetoothLE extends HybridObject<{ android: 'kotlin'; ios: 'swift' }> {
  /**
   * The state of the Bluetooth adapter:
   * `on`, `off`, `unauthorized` (permission refused), `unsupported`, `resetting` or `unknown`.
   * On iOS the first call can return `unknown` until CoreBluetooth reports. Use `setStateListener`.
   */
  getState(): string

  /**
   * Call `listener` each time the adapter state changes. Replaces an earlier listener.
   * The listener is also called once with the current state, when the state is known.
   */
  setStateListener(listener: (state: string) => void): void

  /**
   * Ask the user to turn Bluetooth on, with the system dialog ("Turn on Bluetooth?" on Android).
   * Resolves true when Bluetooth is on (it was on, or the user said yes), false when the user said no.
   * Android 12+ needs the BLUETOOTH_CONNECT permission first. iOS has no such dialog for apps: it resolves
   * the current state at once (iOS shows its own "Turn on Bluetooth" alert when Bluetooth is off at the first use).
   */
  requestEnable(): Promise<boolean>

  /**
   * Scan for devices. Calls `onResult` for each device. The promise resolves when the
   * scan ends (`timeoutMs` passed, or `stopScan()` was called). It rejects when the
   * scan cannot start. A new scan stops an earlier one.
   */
  scan(options: BleScanOptions, onResult: (result: BleScanResult) => void): Promise<void>

  /** End a running scan. Does nothing when no scan runs. */
  stopScan(): Promise<void>

  /**
   * Open a GATT link to a device. The id comes from a scan (`BleScanResult.id`).
   * Rejects after `timeoutMs` if the device does not answer (out of range, off).
   * `onDisconnect` is called once, with a reason, when the link closes for any reason
   * after this promise resolved (also when you call `disconnect()`).
   */
  connect(deviceId: string, timeoutMs: number, onDisconnect: (reason: string) => void): Promise<BleConnection>
}
