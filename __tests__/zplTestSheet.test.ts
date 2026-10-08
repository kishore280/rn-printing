import { readFileSync } from 'fs';
import { join } from 'path';
import { utf8Encode } from '../src/encoding';
import { parseZpl } from '../src/zplParse';

/** docs/BPLZ-TEST-SHEET.md: one label sent as several BLE writes. */
const doc = readFileSync(join(__dirname, '..', 'docs', 'BPLZ-TEST-SHEET.md'), 'utf8');
const parts = Array.from(doc.matchAll(/### Part (\d+) of (\d+)\n+```zpl\n([^\n]+)\n```/g)).map((m) => ({
  n: Number(m[1]),
  of: Number(m[2]),
  zpl: m[3] as string,
}));
const whole = parts.map((p) => p.zpl).join('');

describe('docs/BPLZ-TEST-SHEET.md', () => {
  it('has numbered parts in order', () => {
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((p) => p.n)).toEqual(parts.map((_, i) => i + 1));
    expect(parts.every((p) => p.of === parts.length)).toBe(true);
  });

  it('keeps every part inside one write (MTU 247 gives 244 bytes)', () => {
    for (const p of parts) expect(utf8Encode(p.zpl).length).toBeLessThanOrEqual(240);
  });

  it('puts ^XA only in the first part and ^XZ only in the last', () => {
    parts.forEach((p, i) => {
      expect(p.zpl.includes('^XA')).toBe(i === 0);
      expect(p.zpl.includes('^XZ')).toBe(i === parts.length - 1);
    });
  });

  it('splits only after a field ends (^FS)', () => {
    for (const p of parts.slice(0, -1)) expect(p.zpl.endsWith('^FS')).toBe(true);
  });

  it('reads as one label with no parser errors', () => {
    const d = parseZpl(whole, { printerWidthDots: 864 });
    expect(d.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(d.labels).toHaveLength(1);
    expect(d.labels[0]).toMatchObject({ widthDots: 864, lengthDots: 560, copies: 1 });
    expect(d.labels[0]?.elements.length).toBeGreaterThan(40);
  });

  it('draws every element inside the label', () => {
    const d = parseZpl(whole);
    expect(d.issues.filter((i) => i.code === 'OUTSIDE')).toEqual([]);
  });
});
