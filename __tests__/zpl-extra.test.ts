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

describe('zplSettings from the Zebra guide', () => {
  const { zplSettings, ZplLabel, MAX_GF_BYTES } = require('../src/zpl');

  it('darkness is 0 to 30 with two digits', () => {
    expect(zplSettings.darkness(5)).toBe('~SD05');
    expect(zplSettings.darkness(30)).toBe('~SD30');
    expect(() => zplSettings.darkness(31)).toThrow(RangeError);
    expect(() => zplSettings.darkness(-1)).toThrow(RangeError);
  });
  it('a change of darkness is -30 to 30', () => {
    expect(zplSettings.darknessChange(-5)).toBe('^XA^MD-5^XZ');
    expect(zplSettings.darknessChange(30)).toBe('^XA^MD30^XZ');
    expect(() => zplSettings.darknessChange(31)).toThrow(RangeError);
    expect(() => zplSettings.darknessChange(1.5)).toThrow(RangeError);
  });
  it('tear-off is a sign and three digits, -120 to 120', () => {
    expect(zplSettings.tearOff(10)).toBe('~TA+010');
    expect(zplSettings.tearOff(-5)).toBe('~TA-005');
    expect(zplSettings.tearOff(0)).toBe('~TA+000');
    expect(() => zplSettings.tearOff(121)).toThrow(RangeError);
  });
  it('speed is 2 to 14', () => {
    expect(zplSettings.speed(4)).toBe('^XA^PR4^XZ');
    expect(() => zplSettings.speed(1)).toThrow(RangeError);
    expect(() => zplSettings.speed(15)).toThrow(RangeError);
  });
  it('save and recall use ^JU', () => {
    expect(zplSettings.saveSettings()).toBe('^XA^JUS^XZ');
    expect(zplSettings.recallSettings()).toBe('^XA^JUR^XZ');
  });
  it('the configuration label is ~WC', () => {
    expect(zplSettings.configLabel()).toBe('~WC');
  });
  it('an image over 99999 bytes is refused, not cut', () => {
    const bytesPerRow = 108;
    const rows = Math.floor(MAX_GF_BYTES / bytesPerRow) + 1;
    const bitmap = { width: 864, height: rows, bytesPerRow, data: new Uint8Array(0) };
    expect(() => new ZplLabel({ widthDots: 864, lengthDots: 1200 }).image(0, 0, bitmap, new Uint8Array(4))).toThrow(RangeError);
    const ok = { ...bitmap, height: rows - 1 };
    expect(() => new ZplLabel({ widthDots: 864, lengthDots: 1200 }).image(0, 0, ok, new Uint8Array(4))).not.toThrow();
  });
});
