import type { HybridObject } from 'react-native-nitro-modules'

/**
 * An open Bluetooth Classic (RFCOMM / SPP) link to one printer.
 * Get it from {@linkcode ClassicBluetooth.connect}.
 */
export interface ClassicConnection extends HybridObject<{ android: 'kotlin' }> {
  /** True while the link is open. */
  readonly isConnected: boolean

  /**
   * Send bytes in 1024-byte pieces.
   * @param chunkDelayMs Wait this long between pieces. Use 0 for no wait.
   */
  write(data: ArrayBuffer, chunkDelayMs: number): Promise<void>

  /**
   * Read bytes. Stops at `timeoutMs`, or after the first data arrives and
   * `idleMs` pass with no new data, or at `maxBytes` (0 means no limit).
   */
  read(timeoutMs: number, idleMs: number, maxBytes: number): Promise<ArrayBuffer>

  /** Close the link. */
  close(): Promise<void>
}
