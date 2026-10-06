import { ZplLabel, escapeFieldData, mmToDots, testLabel } from '../src/zpl';

describe('zpl', () => {
  it('converts mm to dots', () => {
    expect(mmToDots(50)).toBe(400);
    expect(mmToDots(25, 12)).toBe(300);
  });

  it('escapes special characters', () => {
    expect(escapeFieldData('a_b^c~d')).toBe('a_5Fb_5Ec_7Ed');
    expect(escapeFieldData('a\nb')).toBe('a b');
  });

  it('builds a label', () => {
    const z = new ZplLabel({ widthDots: 400, lengthDots: 240, copies: 2 })
      .text(10, 20, 'Hi', { height: 30 })
      .toString();
    expect(z).toBe('^XA^PW400^LL240^CI28^FO10,20^A0N,30,30^FH_^FDHi^FS^PQ2^XZ');
  });

  it('omits ^CI28 when charset is none', () => {
    const z = new ZplLabel({ widthDots: 8, lengthDots: 8, charset: 'none' }).toString();
    expect(z).toBe('^XA^PW8^LL8^PQ1^XZ');
  });

  it('builds barcode, qr and box', () => {
    const z = new ZplLabel({ widthDots: 400, lengthDots: 240 })
      .barcode128(0, 0, 'ABC', { height: 50, showText: false })
      .qr(0, 0, 'x', { magnification: 5, errorCorrection: 'H' })
      .box(1, 2, 3, 4)
      .toString();
    expect(z).toContain('^BY2^BCN,50,N,N,N^FH_^FDABC^FS');
    expect(z).toContain('^BQN,2,5^FH_^FDHA,x^FS');
    expect(z).toContain('^FO1,2^GB3,4,2^FS');
  });

  it('rejects bad numbers', () => {
    expect(() => new ZplLabel({ widthDots: 0, lengthDots: 10 })).toThrow(RangeError);
    expect(() => new ZplLabel({ widthDots: 10, lengthDots: 10 }).text(1.5, 0, 'x')).toThrow(RangeError);
    expect(() => new ZplLabel({ widthDots: 10, lengthDots: 10 }).qr(0, 0, 'x', { magnification: 11 })).toThrow(RangeError);
  });

  it('encodes UTF-8 bytes', () => {
    const bytes = new ZplLabel({ widthDots: 8, lengthDots: 8 }).text(0, 0, 'é').toBytes();
    expect(Array.from(bytes)).toContain(0xc3);
  });

  it('makes a test label', () => {
    expect(testLabel().toString().startsWith('^XA^PW400^LL240')).toBe(true);
  });
});
