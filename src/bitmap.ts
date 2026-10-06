/** A 1-bit image. Bit value 1 means a black dot. Rows are padded to whole bytes. */
export interface Bitmap1bpp {
  width: number;
  height: number;
  bytesPerRow: number;
  /** bytesPerRow * height bytes. Most significant bit is the left pixel. */
  data: Uint8Array;
}

/**
 * How grey pixels become black and white dots.
 * 'threshold' suits text and line art. 'floyd-steinberg' and 'atkinson' keep
 * photo detail. 'bayer' is fast and has no worm patterns.
 */
export type DitherMethod = 'threshold' | 'floyd-steinberg' | 'atkinson' | 'bayer';

export interface DitherOptions {
  method?: DitherMethod | undefined;
  /** Grey level for 'threshold' (0 to 255). Default 128. */
  threshold?: number | undefined;
  /** Swap black and white. Default false. */
  invert?: boolean | undefined;
}
