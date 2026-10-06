import { BplaLabel } from '../src/bpla';

describe('BplaLabel', () => {
  it('builds a label', () => {
    const z = new BplaLabel().text(100, 20, 'Hi').quantity(2).toString();
    expect(z).toBe('\x02L\r1211000' + '0100' + '0020' + 'Hi\rQ0002\rE\r');
  });

  it('builds a barcode with and without text', () => {
    expect(new BplaLabel().barcode128(10, 20, 'ABC', { height: 50 }).toString()).toContain('1E52050' + '0010' + '0020' + 'ABC');
    expect(new BplaLabel().barcode128(10, 20, 'ABC', { showText: false }).toString()).toContain('1e');
  });

  it('builds a box', () => {
    expect(new BplaLabel().box(1, 2, 300, 100, 3).toString()).toContain('1X11000' + '0001' + '0002' + 'b' + '0300' + '0100' + '0003' + '0003');
  });

  it('rejects bad values', () => {
    expect(() => new BplaLabel().text(1, 2, 'x', { font: '9' })).toThrow(RangeError);
    expect(() => new BplaLabel().text(10000, 2, 'x')).toThrow(RangeError);
    expect(() => new BplaLabel().barcode(0, 0, 'ean13', 'x', { wide: 10 })).toThrow(RangeError);
    expect(() => new BplaLabel().heat(31)).toThrow(RangeError);
  });
});
