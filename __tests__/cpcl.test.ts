import { CpclLabel, cpclSettings } from '../src/cpcl';
import { ditherGray } from '../test/reference/dither';
const bitmapFromGray = (g: number[], w: number, h: number) => ditherGray(Uint8Array.from(g), w, h);

describe('CpclLabel', () => {
  it('builds a label', () => {
    const z = new CpclLabel({ widthDots: 400, heightDots: 240, copies: 2 })
      .text(10, 20, 'Hi', { size: 1 })
      .box(0, 0, 100, 50, 2)
      .line(0, 60, 100, 60)
      .toString();
    expect(z).toBe(
      '! 0 203 203 240 2\r\nPW 400\r\nTEXT 0 1 10 20 Hi\r\nBOX 0 0 100 50 2\r\nLINE 0 60 100 60 1\r\nPRINT\r\n'
    );
  });

  it('builds rotated text, barcode and QR', () => {
    const z = new CpclLabel({ widthDots: 400, heightDots: 240 })
      .text(1, 2, 'a', { rotation: 90 })
      .barcode128(5, 6, 'ABC', { height: 40, showText: false })
      .qr(7, 8, 'data')
      .toString();
    expect(z).toContain('TEXT90 0 0 1 2 a');
    expect(z).toContain('BARCODE-TEXT OFF\r\nBARCODE 128 2 1 40 5 6 ABC');
    expect(z).toContain('B QR 7 8 M 2 U 6\r\nMA,data\r\nENDQR');
  });

  it('puts image bytes after CG', () => {
    const bm = bitmapFromGray([0, 255, 0, 255, 0, 255, 0, 255], 8, 1);
    const out = new CpclLabel({ widthDots: 8, heightDots: 8 }).image(3, 4, bm).toBytes();
    const text = Array.from(out, (b) => String.fromCharCode(b)).join('');
    expect(text).toContain('CG 1 1 3 4 \xAA\r\n'); // 10101010 = 0xAA
  });

  it('removes line breaks from text and rejects bad numbers', () => {
    expect(new CpclLabel({ widthDots: 8, heightDots: 8 }).text(0, 0, 'a\nb').toString()).toContain('a b');
    expect(() => new CpclLabel({ widthDots: 0, heightDots: 8 })).toThrow(RangeError);
  });

  it('makes settings', () => {
    expect(cpclSettings.speed(3)).toBe('! U1 SPEED 3\r\n');
    expect(cpclSettings.printMode('peel')).toBe('! U1 PRINT-MODE P N\r\n');
  });
});
