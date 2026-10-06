import { compressBitmap, ditherGray, ditherRgba } from '../src/image';
import { NativeModuleMissingError } from '../src/errors';
import { setNativeCodec } from '../src/native';
import type { BplzCodec } from '../src/specs/BplzCodec.nitro';
import { ditherGray as refGray, ditherRgba as refRgba } from '../test/reference/dither';
import { compressZplBitmap } from '../test/reference/zplCompress';

const toAb = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const view = (b: ArrayBuffer) => new Uint8Array(b);

/** A codec double built on the reference code. It tests the TypeScript wiring, not the C++. */
const fake = {
  ditherRgba: async (b: ArrayBuffer, w: number, h: number, m: any, t: number, i: boolean) =>
    toAb(refRgba(view(b), w, h, { method: m, threshold: t, invert: i }).data),
  ditherGray: async (b: ArrayBuffer, w: number, h: number, m: any, t: number, i: boolean) =>
    toAb(refGray(view(b), w, h, { method: m, threshold: t, invert: i }).data),
  zplCompress: async (b: ArrayBuffer, bpr: number) => toAb(compressZplBitmap(view(b), bpr)),
  base64Encode: () => '',
} as unknown as BplzCodec;

describe('image API', () => {
  afterEach(() => setNativeCodec(undefined));

  it('passes arguments through and wraps the result', async () => {
    setNativeCodec(fake);
    const rgba = Uint8Array.from([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
    const bm = await ditherRgba(rgba, 3, 1, { threshold: 128 });
    expect(bm).toMatchObject({ width: 3, height: 1, bytesPerRow: 1 });
    expect(Array.from(bm.data)).toEqual([0b10100000]);
    const g = await ditherGray(Uint8Array.of(0, 255), 2, 1, { invert: true });
    expect(Array.from(g.data)).toEqual([0b01000000]);
    const body = await compressBitmap({ width: 16, height: 1, bytesPerRow: 2, data: Uint8Array.of(0, 0) });
    expect(String.fromCharCode(...body)).toBe(',');
  });

  it('checks the input size before the native call', async () => {
    setNativeCodec(fake);
    await expect(ditherRgba(new Uint8Array(3), 1, 1)).rejects.toThrow(RangeError);
  });

  it('fails loudly when the native module is missing', async () => {
    setNativeCodec(null);
    await expect(ditherGray(Uint8Array.of(1), 1, 1)).rejects.toBeInstanceOf(NativeModuleMissingError);
  });
});
