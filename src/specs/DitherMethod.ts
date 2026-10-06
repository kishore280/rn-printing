/**
 * How grey pixels become black and white dots for {@linkcode BplzCodec.dither}.
 * 'threshold' suits text and line art. 'floyd-steinberg' and 'atkinson' keep
 * photo detail. 'bayer' is fast and has no worm patterns.
 */
export type DitherMethod = 'threshold' | 'floyd-steinberg' | 'atkinson' | 'bayer'
