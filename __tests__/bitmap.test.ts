import { ZplLabel, zplDownloadImage } from '../src/zpl';
import { utf8Encode } from '../src/encoding';
import { ditherGray, ditherRgba } from '../test/reference/dither';
import { compressZplBitmap } from '../test/reference/zplCompress';

const bits = (g: number[], w: number, h: number) => ditherGray(Uint8Array.from(g), w, h);
const text = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join('');

describe('reference bitmap packing', () => {
  it('packs bits, most significant first', () => {
    const bm = bits([0, 255, 0, 255, 0, 255, 0, 255, 0], 9, 1);
    expect(bm.bytesPerRow).toBe(2);
    expect(Array.from(bm.data)).toEqual([0xaa, 0x80]);
  });

  it('treats transparent pixels as white and supports invert', () => {
    const rgba = [0, 0, 0, 0, 0, 0, 0, 255];
    expect(Array.from(ditherRgba(rgba, 2, 1).data)).toEqual([0x40]);
    expect(Array.from(ditherRgba(rgba, 2, 1, { invert: true }).data)).toEqual([0x80]);
  });
});

describe('ZplLabel image', () => {
  const bm = bits([0, 255, 0, 255, 0, 255, 0, 255], 8, 1);
  const body = compressZplBitmap(bm.data, bm.bytesPerRow);

  it('puts the compressed body in ^GFA', () => {
    const label = new ZplLabel({ widthDots: 8, lengthDots: 8 }).image(1, 2, bm, body);
    expect(label.toString()).toContain('^FO1,2^GFA,1,1,1,HA^FS');
    expect(Array.from(label.toBytes())).toEqual(Array.from(utf8Encode(label.toString())));
  });

  it('downloads and recalls', () => {
    expect(text(zplDownloadImage('logo', bm, body))).toBe('~DGR:LOGO.GRF,1,1,HA');
    expect(new ZplLabel({ widthDots: 8, lengthDots: 8 }).recall(0, 0, 'logo').toString()).toContain('^XGR:LOGO.GRF,1,1^FS');
    expect(() => new ZplLabel({ widthDots: 8, lengthDots: 8 }).recall(0, 0, 'bad name!')).toThrow(RangeError);
  });
});
