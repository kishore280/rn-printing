import { setNativeCodec } from '../src/native';
import type { BplzCodec } from '../src/specs/BplzCodec.nitro';
import { ditherGray as refGray } from '../test/reference/dither';
import { compressZplBitmap } from '../test/reference/zplCompress';
import { buildHardwarePayloads, noisePicture, testPicture } from '../example/hardwarePayloads';
import { LabelPrinter } from '../src/printer';
import { FakeTransport } from './helpers';

const toAb = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const latin1 = (b: Uint8Array) => Buffer.from(b).toString('latin1');

// The hardware payloads are plain BPLZ. They are checked here without any transport.
describe('real-printer test payloads', () => {
  beforeEach(() =>
    setNativeCodec({
      ditherGray: async (b: ArrayBuffer, w: number, h: number, m: any, t: number, i: boolean) =>
        toAb(refGray(new Uint8Array(b), w, h, { method: m, threshold: t, invert: i }).data),
      zplCompress: async (b: ArrayBuffer, bpr: number) => toAb(compressZplBitmap(new Uint8Array(b), bpr)),
    } as unknown as BplzCodec)
  );
  afterEach(() => setNativeCodec(undefined));

  it('builds A to G, each as valid ZPL', async () => {
    const payloads = await buildHardwarePayloads();
    expect(payloads.map((p) => p.id)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
    for (const p of payloads) {
      expect(p.expect.length).toBeGreaterThan(0);
      for (const label of p.labels) {
        const text = latin1(label.toBytes());
        expect(text.startsWith('^XA')).toBe(true);
        expect(text.endsWith('^XZ')).toBe(true);
      }
    }
  });

  it('A says HELLO FROM BLE; C is a QR; D is Code 128; G is ten numbered labels', async () => {
    const byId = Object.fromEntries((await buildHardwarePayloads()).map((p) => [p.id, p]));
    expect(latin1(byId.A!.labels[0]!.toBytes())).toContain('HELLO FROM BLE');
    expect(latin1(byId.C!.labels[0]!.toBytes())).toContain('^BQN');
    expect(latin1(byId.D!.labels[0]!.toBytes())).toContain('^BC');
    expect(byId.G!.labels).toHaveLength(10);
    byId.G!.labels.forEach((l, i) => expect(latin1(l.toBytes())).toContain(`LABEL ${i + 1} OF 10`));
  });

  it('F is large: more than 50 KB for the picture and more than 100 KB for the noise label (100 x 100 mm, 203 dpi)', async () => {
    const f = (await buildHardwarePayloads()).find((p) => p.id === 'F')!;
    expect(f.labels).toHaveLength(2);
    expect(f.labels[0]!.toBytes().length).toBeGreaterThan(5 * 1024);
    expect(f.labels[1]!.toBytes().length).toBeGreaterThan(100 * 1024);
  });

  it('follows the media size and dots per mm that it is given (no built-in 203 dpi)', async () => {
    const at203 = await buildHardwarePayloads({ labelWidthMm: 40, labelLengthMm: 20, largeWidthMm: 20, largeLengthMm: 20 });
    const at300 = await buildHardwarePayloads({ dotsPerMm: 12, labelWidthMm: 40, labelLengthMm: 20, largeWidthMm: 20, largeLengthMm: 20 });
    expect(latin1(at203[0]!.labels[0]!.toBytes())).toContain('^PW320^LL160');
    expect(latin1(at300[0]!.labels[0]!.toBytes())).toContain('^PW480^LL240');
    expect(at300[5]!.labels[1]!.toBytes().length).toBeGreaterThan(at203[5]!.labels[1]!.toBytes().length);
  });

  it('makes the same pictures every time', () => {
    expect(noisePicture(64, 64, 1)).toEqual(noisePicture(64, 64, 1));
    expect(noisePicture(64, 64, 1)).not.toEqual(noisePicture(64, 64, 2));
    expect(testPicture(64, 64)).toEqual(testPicture(64, 64));
  });

  it('prints all payloads through a LabelPrinter, label by label, in order', async () => {
    const transport = new FakeTransport();
    const printer = new LabelPrinter(transport);
    const g = (await buildHardwarePayloads()).find((p) => p.id === 'G')!;
    await printer.printAll(g.labels);
    expect(transport.written).toHaveLength(10);
    transport.written.forEach((w, i) => expect(latin1(w)).toContain(`LABEL ${i + 1} OF 10`));
  });
});
