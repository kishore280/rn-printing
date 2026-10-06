import type { HybridObject } from 'react-native-nitro-modules'
import type { BleCharacteristic } from './BleCharacteristic'

/**
 * An open GATT link to one device. Get it from {@linkcode BluetoothLE.connect}.
 * The object only moves bytes. It does not know what the bytes mean.
 */
export interface BleConnection extends HybridObject<{ android: 'kotlin'; ios: 'swift' }> {
  /** The device id that was used to connect. */
  readonly id: string

  /** True while the link is open. */
  readonly isConnected: boolean

  /**
   * The agreed ATT MTU in bytes.
   * iOS does not tell the MTU. There it is the largest write without response, plus 3.
   */
  readonly mtu: number

  /**
   * Did this link call back after a write without response? For tests and logs only.
   * Android: `yes` or `no` once the first write without response was tried, else `unknown`.
   * iOS: `not applicable` (iOS has no such callback; it uses canSendWriteWithoutResponse).
   */
  readonly noResponseCallback: string

  /**
   * Ask for a bigger MTU. Android only. Resolves with the MTU the device agreed to.
   * On iOS it does nothing and resolves with the current `mtu`, because iOS negotiates the MTU by itself.
   */
  requestMtu(mtu: number): Promise<number>

  /** Find all services and characteristics, with their properties. */
  discover(): Promise<BleCharacteristic[]>

  /**
   * The largest number of bytes one `write()` call can take on this link.
   * Android: MTU - 3 (at most 512 for writes with response).
   * iOS: `maximumWriteValueLength` of the peripheral. Returns 0 when not known yet.
   */
  maxWriteLength(withResponse: boolean): number

  /**
   * Write ONE piece to a characteristic. The piece must not be longer than `maxWriteLength()`.
   * With response: resolves when the device confirms the write.
   * Without response: resolves when the stack accepts the piece (iOS waits until its queue has room).
   * Rejects after `timeoutMs`. The caller splits big jobs and calls this one piece at a time.
   */
  write(
    serviceUuid: string,
    characteristicUuid: string,
    data: ArrayBuffer,
    withResponse: boolean,
    timeoutMs: number
  ): Promise<void>

  /**
   * Read the value of ONE characteristic. It must have the read property.
   * Rejects with `[E_NOT_READABLE]` when it has not, and with `[E_AUTH]` when the device needs pairing first.
   * For tools that show what a device offers (like nRF Connect). A print job does not need it.
   */
  read(serviceUuid: string, characteristicUuid: string): Promise<ArrayBuffer>

  /**
   * Turn on notifications (or indications) for a characteristic and call `onData` for each packet.
   * Replaces an earlier subscription for the same characteristic.
   */
  subscribe(serviceUuid: string, characteristicUuid: string, onData: (data: ArrayBuffer) => void): Promise<void>

  /** Turn off notifications for a characteristic. */
  unsubscribe(serviceUuid: string, characteristicUuid: string): Promise<void>

  /** Close the link. Safe to call more than once. */
  disconnect(): Promise<void>
}
