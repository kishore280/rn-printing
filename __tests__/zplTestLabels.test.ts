import { readFileSync } from 'fs';
import { join } from 'path';
import { utf8Encode } from '../src/encoding';
import { parseZpl } from '../src/zplParse';

/** The test labels in docs/BPLZ-TEST-LABELS.md. Each must fit one BLE write and parse without errors. */
const doc = readFileSync(join(__dirname, '..', 'docs', 'BPLZ-TEST-LABELS.md'), 'utf8');
const blocks = Array.from(doc.matchAll(/### ([^\n]+)\n+```zpl\n([^\n]+)\n```/g)).map((m) => ({
  title: m[1] as string,
  zpl: m[2] as string,
}));

describe('docs/BPLZ-TEST-LABELS.md', () => {
  it('has the labels', () => {
    expect(blocks.length).toBe(22);
  });

  it.each(blocks)('$title fits one write of 200 bytes', ({ zpl }) => {
    expect(utf8Encode(zpl).length).toBeLessThanOrEqual(200);
  });

  it.each(blocks.filter((b) => b.zpl.startsWith('^XA')))('$title has no parser errors', ({ zpl }) => {
    const errors = parseZpl(zpl).issues.filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
  });

  it('reads the compressed image test as 32 x 32 dots', () => {
    const b = blocks.find((x) => x.title.startsWith('T12b'));
    const img = parseZpl(b?.zpl ?? '').labels[0]?.elements[0];
    expect(img).toMatchObject({ kind: 'image', width: 32, height: 32 });
  });

  it('uses only text that is easy to paste (no tabs, no line breaks inside a label)', () => {
    for (const b of blocks) expect(b.zpl).not.toMatch(/[\t\r\n]/);
  });
});
