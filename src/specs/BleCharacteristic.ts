/**
 * One GATT characteristic found on a connected device.
 * @see {@linkcode BleConnection.discover}
 */
export interface BleCharacteristic {
  /** UUID of the service that holds the characteristic (lower case, 128-bit form). */
  serviceUuid: string
  /** UUID of the characteristic (lower case, 128-bit form). */
  uuid: string
  /** The characteristic can be read. */
  read: boolean
  /** The characteristic accepts "write with response". */
  write: boolean
  /** The characteristic accepts "write without response". */
  writeWithoutResponse: boolean
  /** The characteristic can send notifications. */
  notify: boolean
  /** The characteristic can send indications. */
  indicate: boolean
}
