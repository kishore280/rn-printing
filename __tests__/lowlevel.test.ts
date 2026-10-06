import { compressZplBitmap, decompressZplBitmap } from '../test/reference/zplCompress';
import { ditherGray, grayFromRgba, resizeGray } from '../test/reference/dither';
import { base64Decode, base64Encode } from '../src/encoding';

// A small, fixed random generator, so the tests give the same result every run.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('ZPL compression', () => {
  it('matches known examples', () => {
    const c = (bytes: number[], bpr: number) =>
      Array.from(compressZplBitmap(Uint8Array.from(bytes), bpr), (b) => String.fromCharCode(b)).join('');
    expect(c([0, 0, 0, 0], 4)).toBe(',');
    expect(c([255, 255], 2)).toBe('!');
    expect(c([0xaa, 0xaa], 2)).toBe('JA'); // four 'A': J is 4
  });

  it('round-trips random and structured bitmaps', () => {
    const r = rng(7);
    for (let trial = 0; trial < 200; trial++) {
      const bpr = 1 + Math.floor(r() * 40);
      const rows = 1 + Math.floor(r() * 30);
      const data = new Uint8Array(bpr * rows);
      const mode = trial % 4;
      for (let i = 0; i < data.length; i++) {
        if (mode === 0) data[i] = Math.floor(r() * 256);
        else if (mode === 1) data[i] = r() < 0.8 ? 0 : 255;
        else if (mode === 2) data[i] = r() < 0.5 ? 0xaa : 0;
        else data[i] = (i % bpr) < bpr / 2 ? 0 : 255; // identical rows
      }
      const packed = compressZplBitmap(data, bpr);
      expect(Array.from(decompressZplBitmap(packed, bpr))).toEqual(Array.from(data));
    }
  });

  it('handles long runs', () => {
    const data = new Uint8Array(1000).fill(0x11); // 2000 hex characters of '1'
    expect(Array.from(decompressZplBitmap(compressZplBitmap(data, 1000), 1000))).toEqual(Array.from(data));
  });

  it('is smaller for flat images', () => {
    const data = new Uint8Array(48 * 100);
    data.fill(0xff, 0, 48 * 20);
    expect(compressZplBitmap(data, 48).length).toBeLessThan(data.length / 10);
  });
});

describe('base64', () => {
  it('round-trips random bytes and matches Buffer', () => {
    const r = rng(3);
    for (let n = 0; n < 300; n++) {
      const data = Uint8Array.from({ length: n }, () => Math.floor(r() * 256));
      const enc = base64Encode(data);
      expect(enc).toBe(Buffer.from(data).toString('base64'));
      expect(Array.from(base64Decode(enc))).toEqual(Array.from(data));
    }
  });

  it('handles big input', () => {
    const data = new Uint8Array(100000).map((_, i) => i & 255);
    expect(base64Encode(data)).toBe(Buffer.from(data).toString('base64'));
  });
});

describe('dither', () => {
  const ramp = (w: number, h: number) => Uint8Array.from({ length: w * h }, (_, i) => Math.round(((i % w) / (w - 1)) * 255));

  it('keeps the overall darkness for every method', () => {
    const w = 64;
    const h = 64;
    const g = ramp(w, h);
    for (const method of ['floyd-steinberg', 'atkinson', 'bayer'] as const) {
      const bm = ditherGray(g, w, h, { method });
      let black = 0;
      bm.data.forEach((b) => { for (let k = 0; k < 8; k++) if (b & (1 << k)) black++; });
      const ratio = black / (w * h);
      expect(ratio).toBeGreaterThan(0.4);
      expect(ratio).toBeLessThan(0.6);
    }
  });

  it('thresholds', () => {
    const bm = ditherGray(Uint8Array.of(0, 255, 100, 200), 4, 1, { threshold: 128 });
    expect(bm.data[0]).toBe(0b10100000);
  });

  it('computes grey with integer weights', () => {
    expect(grayFromRgba([255, 255, 255, 255], 1, 1)[0]).toBe(255);
    expect(grayFromRgba([0, 0, 0, 255], 1, 1)[0]).toBe(0);
    expect(grayFromRgba([255, 0, 0, 0], 1, 1)[0]).toBe(255);
  });

  it('shrinks by averaging', () => {
    const out = resizeGray(Uint8Array.of(0, 100, 200, 100), 4, 1, 2, 1);
    expect(Array.from(out)).toEqual([50, 150]);
  });
});
