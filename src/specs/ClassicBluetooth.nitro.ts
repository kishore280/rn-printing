import type { HybridObject } from 'react-native-nitro-modules'
import type { BondedDevice } from './BondedDevice'
import type { ClassicConnection } from './ClassicConnection.nitro'

/**
 * Entry point for Bluetooth Classic printers (Android only).
 * The printer must be paired in the phone Bluetooth settings first.
 */
export interface ClassicBluetooth extends HybridObject<{ android: 'kotlin' }> {
  /** True when Bluetooth is on. */
  isEnabled(): boolean

  /** The paired devices. Needs the BLUETOOTH_CONNECT permission on Android 12 and newer. */
  getBondedDevices(): Promise<BondedDevice[]>

  /**
   * Open a link to a paired printer. The secure socket is tried first, then the
   * insecure socket (the other way round when `preferInsecure` is true).
   */
  connect(address: string, preferInsecure: boolean): Promise<ClassicConnection>
}
