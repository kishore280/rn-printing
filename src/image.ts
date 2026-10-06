import type { Bitmap1bpp, DitherOptions } from './bitmap';
import { requireCodec, toArrayBuffer } from './native';

/**
 * Image work runs in the native C++ codec, on a background thread. There is no
 * JavaScript copy of these loops, so the native module must be linked (see README).
 * Decode PNG or JPEG files to pixels with another library first.
 */

function checkSize(name: string, length: number, needed: number): void {
  if (length < needed) throw new RangeError(`${name} is shorter than needed (${length} < ${needed})`);
}

/**
 * RGBA pixels (4 bytes per pixel, row by row) to a 1-bit image.
 * Transparent pixels count as white.
 */
export async function ditherRgba(
  rgba: Uint8Array,
  width: number,
  height: number,
  options: DitherOptions = {}
): Promise<Bitmap1bpp> {
  checkSize('rgba', rgba.length, width * height * 4);
  const buffer = await requireCodec().ditherRgba(
    toArrayBuffer(rgba),
    width,
    height,
    options.method ?? 'threshold',
    options.threshold ?? 128,
    options.invert ?? false
  );
  return { width, height, bytesPerRow: (width + 7) >> 3, data: new Uint8Array(buffer) };
}

/** Grey pixels (1 byte per pixel) to a 1-bit image. 0 is black, 255 is white. */
export async function ditherGray(
  gray: Uint8Array,
  width: number,
  height: number,
  options: DitherOptions = {}
): Promise<Bitmap1bpp> {
  checkSize('gray', gray.length, width * height);
  const buffer = await requireCodec().ditherGray(
    toArrayBuffer(gray),
    width,
    height,
    options.method ?? 'threshold',
    options.threshold ?? 128,
    options.invert ?? false
  );
  return { width, height, bytesPerRow: (width + 7) >> 3, data: new Uint8Array(buffer) };
}

/**
 * Compress an image for the ZPL `^GFA` and `~DG` commands. Pass the result to
 * `ZplLabel.image()` or `zplDownloadImage()`. Do it once and print the label many times.
 */
export async function compressBitmap(bitmap: Bitmap1bpp): Promise<Uint8Array> {
  const total = bitmap.bytesPerRow * bitmap.height;
  checkSize('bitmap.data', bitmap.data.length, total);
  const raw = bitmap.data.subarray(0, total);
  return new Uint8Array(await requireCodec().zplCompress(toArrayBuffer(raw), bitmap.bytesPerRow));
}
