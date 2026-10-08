import * as fs from 'fs';
import * as path from 'path';
import { compressBitmap, ditherGray } from '../src/image';
import { setNativeCodec } from '../src/native';
import { CpclLabel } from '../src/cpcl';
import type { BplzCodec } from '../src/specs/BplzCodec.nitro';
import { ditherGray as refGray } from '../test/reference/dither';
import { compressZplBitmap } from '../test/reference/zplCompress';
import { mmToDots, ZplLabel } from '../src/zpl';

const latin1 = (b: Uint8Array) => Buffer.from(b).toString('latin1');
const toAb = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

// Protocol output is tested with NO transport in sight: label -> bytes.

describe('protocol layer does not know about transports', () => {
  const src = path.join(__dirname, '..', 'src');
  it.each(['zpl.ts', 'cpcl.ts', 'bpla.ts', 'image.ts', 'bitmap.ts', 'status.ts', 'encoding.ts', 'validate.ts'])(
    '%s imports no transport, printer or BLE code',
    (file) => {
      const code = fs.readFileSync(path.join(src, file), 'utf8');
      const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] as string);
      expect(imports.filter((i) => /transport|printer|ble|bluetooth|tcp|reconnect/i.test(i))).toEqual([]);
    }
  );
});

describe('BPLZ / ZPL II bytes', () => {
  it('writes the exact commands for a label with text, Code 128 and QR', () => {
    const label = ZplLabel.fromMm(50, 30)
      .text(20, 20, 'Hello', { height: 40 })
      .barcode128(20, 80, '123', { height: 70 })
      .qr(300, 90, 't', { magnification: 3 });
    expect(latin1(label.toBytes())).toBe(
      '^XA^PW400^LL240^CI28^FO20,20^A0N,40,40^FH_^FDHello^FS^FO20,80^BY2^BCN,70,Y,N,N^FH_^FD123^FS' +
        '^FO300,90^BQN,2,3^FH_^FDMA,t^FS^PQ1^XZ'
    );
  });

  it('starts with ^XA and ends with ^XZ, and is plain bytes', () => {
    const bytes = ZplLabel.fromMm(50, 30).text(0, 0, 'x').toBytes();
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(latin1(bytes.subarray(0, 3))).toBe('^XA');
    expect(latin1(bytes.subarray(bytes.length - 3))).toBe('^XZ');
  });

  it('encodes non-ASCII text as UTF-8 bytes and escapes the special characters', () => {
    const bytes = ZplLabel.fromMm(50, 30).text(0, 0, 'é^_').toBytes();
    const text = Buffer.from(bytes).toString('utf8');
    expect(text).toContain('^CI28');
    expect(text).toContain('é_5E_5F');
  });

  it('gives the same bytes every time', () => {
    const make = () => ZplLabel.fromMm(50, 30).text(1, 2, 'a').barcode128(1, 30, '1').toBytes();
    expect(make()).toEqual(make());
  });
});

describe('ZPL image bytes and printer resolution', () => {
  const codec = {
    ditherGray: async (b: ArrayBuffer, w: number, h: number, m: any, t: number, i: boolean) =>
      toAb(refGray(new Uint8Array(b), w, h, { method: m, threshold: t, invert: i }).data),
    zplCompress: async (b: ArrayBuffer, bpr: number) => toAb(compressZplBitmap(new Uint8Array(b), bpr)),
  } as unknown as BplzCodec;
  beforeEach(() => setNativeCodec(codec));
  afterEach(() => setNativeCodec(undefined));

  it.each([
    [8, 400, 50],
    [12, 600, 75],
  ] as const)('at %i dots/mm a 50 mm label is %i dots wide, and its image has %i bytes per row', async (dotsPerMm, dots, bytesPerRow) => {
    expect(mmToDots(50, dotsPerMm)).toBe(dots);
    const label = ZplLabel.fromMm(50, 10, { dotsPerMm });
    const gray = new Uint8Array(dots * 20).fill(0);
    const bitmap = await ditherGray(gray, dots, 20);
    expect(bitmap.bytesPerRow).toBe(bytesPerRow);
    expect(bitmap.data.length).toBe(bytesPerRow * 20);
    const text = latin1(label.image(0, 0, bitmap, await compressBitmap(bitmap)).toBytes());
    expect(text).toContain(`^PW${dots}`);
    expect(text).toContain(`^GFA,${bytesPerRow * 20},${bytesPerRow * 20},${bytesPerRow},`);
  });

  it('rounds a width that is not a multiple of 8 up to whole bytes', async () => {
    const bitmap = await ditherGray(new Uint8Array(13 * 2), 13, 2);
    expect(bitmap.bytesPerRow).toBe(2);
  });

  it('refuses an image whose row size does not fit its width', () => {
    expect(() =>
      ZplLabel.fromMm(50, 30).image(0, 0, { width: 100, height: 2, bytesPerRow: 3, data: new Uint8Array(6) }, new Uint8Array(0))
    ).toThrow(RangeError);
  });

  it('puts the raw image body into the bytes unchanged', async () => {
    const bitmap = await ditherGray(Uint8Array.of(0, 255, 0, 255, 0, 255, 0, 255), 8, 1);
    const body = await compressBitmap(bitmap);
    const bytes = ZplLabel.fromMm(50, 30).image(0, 0, bitmap, body).toBytes();
    expect(latin1(bytes)).toContain('^GFA,1,1,1,' + latin1(body) + '^FS');
  });

  it('CPCL takes the resolution from the option, not from a built-in 203', () => {
    expect(latin1(CpclLabel.fromMm(50, 30, { dpi: 300 }).text(0, 0, 'x').toBytes())).toMatch(/^! 0 300 300 /);
    expect(latin1(CpclLabel.fromMm(50, 30).text(0, 0, 'x').toBytes())).toMatch(/^! 0 203 203 /);
  });
});
