import type { Bitmap1bpp } from '../../src/bitmap';

export type DitherMethod = 'threshold' | 'floyd-steinberg' | 'atkinson' | 'bayer';

export interface DitherOptions {
  method?: DitherMethod;
  /** Grey level for 'threshold' (0 to 255). Default 128. */
  threshold?: number;
  /** Swap black and white. Default false. */
  invert?: boolean;
}

// 8 x 8 Bayer matrix, values 0 to 63.
const BAYER8 = new Uint8Array([
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30,
  54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23,
  61, 29, 53, 21,
]);

/**
 * Grey level of each RGBA pixel as a byte (0 black, 255 white). Integer maths only.
 * Transparent pixels count as white. One pass over a Uint32 view when the memory allows it.
 */
export function grayFromRgba(rgba: ArrayLike<number>, width: number, height: number): Uint8Array {
  const count = width * height;
  if (rgba.length < count * 4) throw new RangeError('rgba is shorter than width * height * 4');
  const gray = new Uint8Array(count);
  for (let p = 0, i = 0; p < count; p++, i += 4) {
    const a = rgba[i + 3] as number;
    // Weights 77, 150, 29 add up to 256, so the shift by 8 is the divide.
    let g = (77 * (rgba[i] as number) + 150 * (rgba[i + 1] as number) + 29 * (rgba[i + 2] as number)) >> 8;
    if (a !== 255) g = (g * a + 255 * (255 - a) + 127) / 255 | 0;
    gray[p] = g;
  }
  return gray;
}

/**
 * Turn grey pixels into a 1-bit image. Error-diffusion methods ('floyd-steinberg',
 * 'atkinson') keep photo detail on thermal paper. 'bayer' is fast and has no
 * worm patterns. 'threshold' is best for text and line art.
 */
export function ditherGray(
  gray: Uint8Array,
  width: number,
  height: number,
  options: DitherOptions = {}
): Bitmap1bpp {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError('width and height must be positive integers');
  }
  if (gray.length < width * height) throw new RangeError('gray is shorter than width * height');
  const method = options.method ?? 'threshold';
  const invert = options.invert ? 1 : 0;
  const bytesPerRow = (width + 7) >> 3;
  const data = new Uint8Array(bytesPerRow * height);

  if (method === 'threshold' || method === 'bayer') {
    const t = options.threshold ?? 128;
    for (let y = 0; y < height; y++) {
      const row = y * width;
      const outRow = y * bytesPerRow;
      const bayerRow = (y & 7) << 3;
      for (let x = 0; x < width; x++) {
        const g = gray[row + x] as number;
        const limit = method === 'bayer' ? (((BAYER8[bayerRow + (x & 7)] as number) * 255) / 63) | 0 : t;
        if (((g < limit) as unknown as number) ^ invert) {
          const idx = outRow + (x >> 3);
          data[idx] = (data[idx] as number) | (0x80 >> (x & 7));
        }
      }
    }
    return { width, height, bytesPerRow, data };
  }

  // Error diffusion. Three (Atkinson: three) rows of Int16 error are kept: this row and the next ones.
  const stride = width + 4;
  const e0 = new Int16Array(stride);
  const e1 = new Int16Array(stride);
  const e2 = new Int16Array(stride);
  let cur = e0;
  let next = e1;
  let next2 = e2;
  const atkinson = method === 'atkinson';
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const outRow = y * bytesPerRow;
    for (let x = 0; x < width; x++) {
      const old = (gray[row + x] as number) + (cur[x + 2] as number);
      const isBlack = old < 128;
      const err = old - (isBlack ? 0 : 255);
      if (((isBlack as unknown as number) ^ invert) !== 0) {
        const idx = outRow + (x >> 3);
        data[idx] = (data[idx] as number) | (0x80 >> (x & 7));
      }
      const c = x + 2;
      if (atkinson) {
        const q = err >> 3; // 1/8 of the error goes to six neighbours (the other 2/8 is dropped)
        cur[c + 1] = (cur[c + 1] as number) + q;
        cur[c + 2] = (cur[c + 2] as number) + q;
        next[c - 1] = (next[c - 1] as number) + q;
        next[c] = (next[c] as number) + q;
        next[c + 1] = (next[c + 1] as number) + q;
        next2[c] = (next2[c] as number) + q;
      } else {
        cur[c + 1] = (cur[c + 1] as number) + ((err * 7) >> 4);
        next[c - 1] = (next[c - 1] as number) + ((err * 3) >> 4);
        next[c] = (next[c] as number) + ((err * 5) >> 4);
        next[c + 1] = (next[c + 1] as number) + (err >> 4);
      }
    }
    // Rotate the rows: the next row becomes the current one, and a cleared row goes last.
    const spare = cur;
    cur = next;
    next = next2;
    next2 = spare;
    next2.fill(0);
  }
  return { width, height, bytesPerRow, data };
}

/** Convenience: RGBA pixels to a dithered 1-bit image. */
export function ditherRgba(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  options: DitherOptions = {}
): Bitmap1bpp {
  return ditherGray(grayFromRgba(rgba, width, height), width, height, options);
}

/**
 * Shrink grey pixels to a new size by averaging the source pixels under each target pixel
 * (box filter). Use it before dithering, so the label is not larger than the printer head.
 */
export function resizeGray(
  gray: Uint8Array,
  width: number,
  height: number,
  newWidth: number,
  newHeight: number
): Uint8Array {
  if (newWidth > width || newHeight > height) throw new RangeError('resizeGray only shrinks');
  const out = new Uint8Array(newWidth * newHeight);
  for (let y = 0; y < newHeight; y++) {
    const y0 = Math.floor((y * height) / newHeight);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / newHeight));
    for (let x = 0; x < newWidth; x++) {
      const x0 = Math.floor((x * width) / newWidth);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / newWidth));
      let sum = 0;
      for (let yy = y0; yy < y1; yy++) {
        const base = yy * width;
        for (let xx = x0; xx < x1; xx++) sum += gray[base + xx] as number;
      }
      out[y * newWidth + x] = (sum / ((y1 - y0) * (x1 - x0))) | 0;
    }
  }
  return out;
}
