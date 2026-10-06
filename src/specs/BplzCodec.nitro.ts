import type { HybridObject } from 'react-native-nitro-modules'
import type { DitherMethod } from './DitherMethod'

/**
 * Fast image and text codecs for label printing, written in C++.
 * The calls run on a background thread and return a Promise.
 * The pure TypeScript functions in this package give the same bytes.
 */
export interface BplzCodec extends HybridObject<{ ios: 'c++'; android: 'c++' }> {
  /** Turn RGBA pixels (`width * height * 4` bytes) into a 1-bit image (`ceil(width / 8) * height` bytes, 1 = black). */
  ditherRgba(
    rgba: ArrayBuffer,
    width: number,
    height: number,
    method: DitherMethod,
    threshold: number,
    invert: boolean
  ): Promise<ArrayBuffer>

  /** Turn grey pixels (`width * height` bytes) into a 1-bit image. See {@linkcode BplzCodec.ditherRgba}. */
  ditherGray(
    gray: ArrayBuffer,
    width: number,
    height: number,
    method: DitherMethod,
    threshold: number,
    invert: boolean
  ): Promise<ArrayBuffer>

  /** Compress a 1-bit image into ZPL ASCII-compressed hex, for `^GFA` and `~DG`. */
  zplCompress(bitmap: ArrayBuffer, bytesPerRow: number): Promise<ArrayBuffer>

  /** Base64 text of the bytes. */
  base64Encode(data: ArrayBuffer): string
}
