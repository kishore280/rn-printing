/**
 * A printer that is paired in the phone Bluetooth settings.
 * @see {@linkcode ClassicBluetooth.getBondedDevices}
 */
export interface BondedDevice {
  /** The device name, or an empty string when the phone has none. */
  name: string
  /** The Bluetooth MAC address, like `00:11:22:33:AA:BB`. */
  address: string
}
