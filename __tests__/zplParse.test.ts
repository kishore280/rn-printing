import { utf8Decode, utf8Encode } from '../src/encoding';
import { ZplLabel } from '../src/zpl';
import { decodeGfaData, parseZpl, validateZpl } from '../src/zplParse';
import type { ZplBarcode1D, ZplImage, ZplQr, ZplText } from '../src/zplParse';
import { compressZplBitmap, hexAscii } from '../test/reference/zplCompress';

const ascii = (u: Uint8Array) => String.fromCharCode(...u);
const codes = (z: string) => validateZpl(z).map((i) => i.code);

describe('utf8Decode', () => {
  it('round-trips text', () => {
    for (const s of ['abc', 'café', '₹ 120', 'கா', 'a\u{1F600}b']) {
      expect(utf8Decode(utf8Encode(s))).toBe(s);
    }
  });
  it('replaces bad bytes and does not throw', () => {
    expect(utf8Decode([0x61, 0xff, 0x62])).toBe('a�b');
    expect(utf8Decode([0xe2, 0x82])).toBe('��');
    expect(utf8Decode([0xc0, 0x80])).toBe('��');
  });
});

describe('decodeGfaData', () => {
  it('reads plain hex', () => {
    expect(Array.from(decodeGfaData('FF00', 2) ?? [])).toEqual([0xff, 0x00]);
  });
  it('reads Zebra compression: counts, fills and repeated rows', () => {
    // 4 bytes per row = 8 nibbles. "K0" = 5 zeros then FFF = 3 F; "," fill; "!" fill; ":" same row.
    const bytes = decodeGfaData('K0FFF,!:', 4);
    expect(Array.from(bytes ?? [])).toEqual([
      0x00, 0x00, 0x0f, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    ]);
  });
  it('rejects bad characters and partial rows', () => {
    expect(decodeGfaData('FFxx', 2)).toBeUndefined();
    expect(decodeGfaData('FFF', 2)).toBeUndefined();
    expect(decodeGfaData(':', 2)).toBeUndefined();
  });
  it('undoes the reference compressor on random bitmaps', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let n = 0; n < 40; n++) {
      const bpr = 1 + Math.floor(rnd() * 40);
      const rows = 1 + Math.floor(rnd() * 30);
      const data = new Uint8Array(bpr * rows);
      const style = n % 4;
      for (let i = 0; i < data.length; i++) {
        data[i] = style === 0 ? 0 : style === 1 ? 0xff : style === 2 ? (rnd() < 0.8 ? 0 : 0xff) : Math.floor(rnd() * 256);
      }
      // Repeat some rows so ':' appears.
      for (let r = 1; r < rows; r += 3) data.copyWithin(r * bpr, (r - 1) * bpr, r * bpr);
      const packed = ascii(compressZplBitmap(data, bpr));
      expect(Array.from(decodeGfaData(packed, bpr) ?? [])).toEqual(Array.from(data));
      expect(Array.from(decodeGfaData(ascii(hexAscii(data)), bpr) ?? [])).toEqual(Array.from(data));
    }
  });
});

describe('parseZpl: what our own builder writes', () => {
  it('reads text, copies and sizes', () => {
    const z = new ZplLabel({ widthDots: 400, lengthDots: 240, copies: 3 }).text(10, 20, 'Hi', { height: 30 }).toString();
    const d = parseZpl(z);
    expect(d.issues).toEqual([]);
    expect(d.labels).toHaveLength(1);
    expect(d.labels[0]).toMatchObject({ widthDots: 400, lengthDots: 240, copies: 3 });
    expect(d.labels[0]?.elements[0]).toEqual({
      kind: 'text', x: 10, y: 20, font: '0', rotation: 'N', height: 30, width: 30, reverse: false, text: 'Hi',
    });
  });

  it('decodes ^FH escapes and UTF-8 text', () => {
    const z = new ZplLabel({ widthDots: 400, lengthDots: 240 }).text(0, 0, 'a_b^c ₹').toString();
    const t = parseZpl(z).labels[0]?.elements[0] as ZplText;
    expect(t.text).toBe('a_b^c ₹');
  });

  it('reads Code 128 with the module width from ^BY', () => {
    const z = new ZplLabel({ widthDots: 400, lengthDots: 240 })
      .barcode128(10, 100, '12345', { height: 50, moduleWidth: 3, showText: false })
      .toString();
    const b = parseZpl(z).labels[0]?.elements[0] as ZplBarcode1D;
    expect(b).toMatchObject({ kind: 'barcode', symbology: 'code128', x: 10, y: 100, height: 50, moduleWidth: 3, showText: false, data: '12345' });
  });

  it('reads every 1D type the builder writes', () => {
    const l = new ZplLabel({ widthDots: 400, lengthDots: 240 });
    const cases = [
      ['code128', 'ABC'], ['code39', 'ABC-12'], ['code93', 'ABC'], ['codabar', 'A1234B'], ['itf', '1234'],
      ['ean13', '5901234123457'], ['ean8', '96385074'], ['upca', '036000291452'], ['upce', '01234565'],
    ] as const;
    for (const [type, data] of cases) l.barcode(0, 0, type, data, { height: 40 });
    const d = parseZpl(l.toString());
    expect(d.issues).toEqual([]);
    const els = d.labels[0]?.elements as ZplBarcode1D[];
    expect(els.map((e) => e.symbology)).toEqual(cases.map((c) => c[0]));
    expect(els.every((e) => e.height === 40)).toBe(true);
  });

  it('reads QR error correction and data', () => {
    const z = new ZplLabel({ widthDots: 400, lengthDots: 240 }).qr(5, 6, 'https://x.test/a', { magnification: 5, errorCorrection: 'Q' }).toString();
    const q = parseZpl(z).labels[0]?.elements[0] as ZplQr;
    expect(q).toMatchObject({ kind: 'qr', x: 5, y: 6, magnification: 5, errorCorrection: 'Q', data: 'https://x.test/a' });
  });

  it('reads a boxed image back to the same bytes', () => {
    const bpr = 4;
    const bytes = Uint8Array.from({ length: bpr * 8 }, (_, i) => (i * 37) & 0xff);
    const compressed = compressZplBitmap(bytes, bpr);
    const z = `^XA^FO7,9^GFA,${bytes.length},${bytes.length},${bpr},${ascii(compressed)}^FS^XZ`;
    const d = parseZpl(z);
    expect(d.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const img = d.labels[0]?.elements[0] as ZplImage;
    expect(img).toMatchObject({ kind: 'image', x: 7, y: 9, width: 32, height: 8, bytesPerRow: bpr });
    expect(Array.from(img.data)).toEqual(Array.from(bytes));
  });
});

describe('parseZpl: SDK-style text and shapes', () => {
  it('reads ^A@ with a font name, reverse, a box and a line', () => {
    const z = '^XA^PW864^LL560^FO10,10^GB200,100,4^FS^FO20,20^A@N,40,30,E:ARIAL.TTF^FH_^FR^FDHello^FS^XZ';
    const d = parseZpl(z);
    const els = d.labels[0]?.elements ?? [];
    expect(els[0]).toMatchObject({ kind: 'box', x: 10, y: 10, width: 200, height: 100, thickness: 4, color: 'B' });
    expect(els[1]).toMatchObject({ kind: 'text', font: 'E:ARIAL.TTF', height: 40, width: 30, reverse: true, text: 'Hello' });
    expect(d.issues.filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('keeps a box at least as large as its thickness (^GB rule)', () => {
    const b = parseZpl('^XA^FO0,0^GB0,0,5^FS^XZ').labels[0]?.elements[0];
    expect(b).toMatchObject({ width: 5, height: 5, thickness: 5 });
  });

  it('uses ^LH as an offset for ^FO', () => {
    const t = parseZpl('^XA^LH10,20^FO5,5^A0N,20,20^FDx^FS^XZ').labels[0]?.elements[0];
    expect(t).toMatchObject({ x: 15, y: 25 });
  });

  it('keeps ^BY and ^CI from one label to the next', () => {
    const d = parseZpl('^XA^PW400^LL200^CI28^BY4^XZ^XA^FO0,0^BCN,30,Y,N,N^FD1^FS^XZ');
    expect((d.labels[1]?.elements[0] as ZplBarcode1D).moduleWidth).toBe(4);
    expect(d.labels[1]?.widthDots).toBe(400);
  });
});

describe('validateZpl', () => {
  it('passes a clean label', () => {
    expect(codes('^XA^PW400^LL240^FO10,10^A0N,30,30^FDHi^FS^PQ1^XZ')).toEqual([]);
  });

  it('flags values outside the SDK ranges as errors', () => {
    expect(codes('^XA^BY11^XZ')).toContain('RANGE');
    expect(codes('^XA^PW1^XZ')).toContain('RANGE');
    expect(codes('^XA^FO0,99999^XZ')).toContain('RANGE');
    expect(codes('^XA^FO0,0^GB10,10,0^FS^XZ')).toContain('RANGE');
    expect(codes('^XA^FO0,0^BQN,2,11^FDMA,x^FS^XZ')).toContain('RANGE');
  });

  it('flags barcode data the symbology cannot hold', () => {
    expect(codes('^XA^FO0,0^BEN,50^FD123^FS^XZ')).toContain('BARCODE_DATA');
    expect(codes('^XA^FO0,0^B3N,N,50^FDabc^FS^XZ')).toContain('BARCODE_DATA');
    expect(codes('^XA^FO0,0^BCN,50^FDé^FS^XZ')).toContain('BARCODE_DATA');
    expect(codes('^XA^FO0,0^BCN,50^FDabc^FS^XZ')).not.toContain('BARCODE_DATA');
  });

  it('flags a wrong QR prefix', () => {
    expect(codes('^XA^FO0,0^BQN,2,3^FDnope^FS^XZ')).toContain('QR_DATA');
  });

  it('warns about commands that are not in the SDK list', () => {
    const i = validateZpl('^XA^FO0,0^FB200,3,0,L^FDx^FS^XZ').find((x) => x.code === 'UNKNOWN_COMMAND');
    expect(i).toMatchObject({ severity: 'warning', command: '^FB' });
  });

  it('warns on missing ^XZ, text outside ^XA and out-of-label placement', () => {
    expect(codes('^XA^FO0,0^A0N,10,10^FDx^FS')).toContain('NO_XZ');
    expect(codes('^FO0,0^A0N,10,10^FDx^FS')).toContain('NO_XA');
    expect(codes('^XA^PW400^LL200^FO400,0^A0N,10,10^FDx^FS^XZ')).toContain('OUTSIDE');
  });

  it('warns about wide characters without ^CI28', () => {
    expect(codes('^XA^FO0,0^A0N,10,10^FD₹^FS^XZ')).toContain('CHARSET');
    expect(codes('^XA^CI28^FO0,0^A0N,10,10^FD₹^FS^XZ')).not.toContain('CHARSET');
  });

  it('checks the printer width when asked', () => {
    expect(validateZpl('^XA^PW900^XZ', { printerWidthDots: 864 }).map((i) => i.code)).toContain('WIDER_THAN_PRINTER');
  });

  it('checks ^GFA sizes and data', () => {
    expect(codes('^XA^FO0,0^GFA,8,8,2,FFFFFFFF^FS^XZ')).toContain('GF_SIZE');
    expect(codes('^XA^FO0,0^GFA,2,2,2,zz^FS^XZ')).toContain('GF_DATA');
  });

  it('never throws on garbage', () => {
    for (const z of ['', '^', '~', '^^^^', '^XA^XA^XZ^XZ', '^FD', '^BQ,,,^FD', '^GFA', '^A', 'abc^FO,,,,']) {
      expect(() => parseZpl(z)).not.toThrow();
    }
  });
});
