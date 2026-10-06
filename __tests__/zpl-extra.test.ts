import { ZplLabel, zplSettings } from '../src/zpl';
import { parseExtendedStatus } from '../src/status';

describe('zpl extras', () => {
  const label = () => new ZplLabel({ widthDots: 400, lengthDots: 240 });

  it('builds other barcodes', () => {
    expect(label().barcode(0, 0, 'ean13', '590123412345').toString()).toContain('^BY2^BEN,60,Y,N^FH_^FD590123412345^FS');
    expect(label().barcode(0, 0, 'code39', 'AB', { showText: false }).toString()).toContain('^B3N,N,60,N,N');
    expect(label().pdf417(0, 0, 'x', { columns: 5 }).toString()).toContain('^B7N,10,2,5,,N');
  });

  it('makes settings', () => {
    expect(zplSettings.printMode('peelOff')).toBe('^XA^MMP^XZ');
    expect(zplSettings.media('label-gap', 'direct-thermal')).toBe('^XA^MNY^MTD^XZ');
    expect(zplSettings.speed(4)).toBe('^XA^PR4^XZ');
    expect(zplSettings.darkness(5)).toBe('~SD05');
  });

  it('parses extended status', () => {
    const s = parseExtendedStatus(' ERRORS: 1 00000000 00000003 WARNINGS: 1 00000000 00000002');
    expect(s?.errors.mediaOut).toBe(true);
    expect(s?.errors.ribbonOut).toBe(true);
    expect(s?.hasWarning).toBe(true);
    expect(parseExtendedStatus('nothing')).toBeNull();
  });
});
