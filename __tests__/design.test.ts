import { checkDesign, designToZpl, vegMinimums, vegSymbolZpl } from '../src/design';
import type { LabelDesign } from '../src/design';
import { parseZpl } from '../src/zplParse';

const base = (items: LabelDesign['items']): LabelDesign => ({ widthMm: 70, heightMm: 50, items });

describe('designToZpl', () => {
  it('converts millimetres to dots at 8 dots per mm', () => {
    const z = designToZpl(base([{ kind: 'text', xMm: 5, yMm: 10, text: 'Sweet', heightMm: 4 }]));
    const t = parseZpl(z).labels[0]?.elements[0];
    expect(t).toMatchObject({ kind: 'text', x: 40, y: 80, height: 32, width: 32, text: 'Sweet' });
  });

  it('writes the label size and copies', () => {
    const d = parseZpl(designToZpl({ ...base([]), copies: 3 }));
    expect(d.labels[0]).toMatchObject({ widthDots: 560, lengthDots: 400, copies: 3 });
  });

  it('uses 12 dots per mm when asked', () => {
    const z = designToZpl({ ...base([{ kind: 'box', xMm: 1, yMm: 1, widthMm: 10, heightMm: 5 }]), dotsPerMm: 12 });
    expect(parseZpl(z).labels[0]?.elements[0]).toMatchObject({ kind: 'box', x: 12, y: 12, width: 120, height: 60 });
  });

  it('fills a filled box', () => {
    const z = designToZpl(base([{ kind: 'box', xMm: 0, yMm: 0, widthMm: 10, heightMm: 4, filled: true }]));
    expect(parseZpl(z).labels[0]?.elements[0]).toMatchObject({ kind: 'box', width: 80, height: 32, thickness: 16 });
  });

  it('uses equal height and width for font 0 when no width is given, and a given width as it is', () => {
    const els = parseZpl(
      designToZpl(
        base([
          { kind: 'text', xMm: 1, yMm: 1, text: 'a', heightMm: 5 },
          { kind: 'text', xMm: 1, yMm: 8, text: 'b', heightMm: 5, widthMm: 5 },
        ])
      )
    ).labels[0]?.elements;
    expect(els?.[0]).toMatchObject({ height: 40, width: 40 });
    expect(els?.[1]).toMatchObject({ height: 40, width: 40 });
  });

  it('never writes a character size under 10 dots (the smallest scalable size)', () => {
    const t = parseZpl(designToZpl(base([{ kind: 'text', xMm: 1, yMm: 1, text: 'tiny', heightMm: 0.5 }]))).labels[0]?.elements[0];
    expect(t).toMatchObject({ height: 10, width: 10 });
  });

  it('writes reverse text with ^FR', () => {
    const z = designToZpl(base([{ kind: 'text', xMm: 1, yMm: 1, text: 'REV', heightMm: 3, reverse: true }]));
    expect(parseZpl(z).labels[0]?.elements[0]).toMatchObject({ kind: 'text', reverse: true, text: 'REV' });
  });

  it('escapes special characters in text', () => {
    const z = designToZpl(base([{ kind: 'text', xMm: 1, yMm: 1, text: 'a^b~c_d', heightMm: 3 }]));
    expect((parseZpl(z).labels[0]?.elements[0] as { text: string }).text).toBe('a^b~c_d');
  });

  it('turns a barcode a quarter turn (^BCR) and warns that a turned barcode is not checked', () => {
    const d = base([{ kind: 'barcode', xMm: 12, yMm: 2, type: 'code128', data: '12345', heightMm: 8, rotation: 90 }]);
    expect(designToZpl(d)).toContain('^BCR,64,Y,N,N');
    expect(designToZpl(base([{ kind: 'barcode', xMm: 12, yMm: 2, type: 'code128', data: '12345', heightMm: 8 }]))).toContain('^BCN,64,Y,N,N');
    expect(checkDesign(d).map((i) => i.code)).toContain('ROTATION');
  });

  it('makes barcodes and QR codes', () => {
    const z = designToZpl(
      base([
        { kind: 'barcode', xMm: 2, yMm: 30, type: 'code128', data: '12345', heightMm: 8, showText: false },
        { kind: 'qr', xMm: 40, yMm: 2, data: 'HELLO', cell: 3, errorCorrection: 'Q' },
      ])
    );
    const els = parseZpl(z).labels[0]?.elements ?? [];
    expect(els[0]).toMatchObject({ kind: 'barcode', symbology: 'code128', x: 16, y: 240, height: 64, showText: false, data: '12345' });
    expect(els[1]).toMatchObject({ kind: 'qr', errorCorrection: 'Q', magnification: 3, data: 'HELLO' });
  });

  it('keeps the parser clean for any random design of safe items', () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    for (let run = 0; run < 50; run++) {
      const items: LabelDesign['items'] = [];
      for (let i = 0; i < 1 + rnd(8); i++) {
        const k = rnd(4);
        const xMm = rnd(60);
        const yMm = rnd(40);
        if (k === 0) items.push({ kind: 'text', xMm, yMm, text: `T${rnd(1000)}`, heightMm: 2 + rnd(5) });
        else if (k === 1) items.push({ kind: 'box', xMm, yMm, widthMm: 1 + rnd(30), heightMm: 1 + rnd(20) });
        else if (k === 2) items.push({ kind: 'barcode', xMm, yMm, type: 'code128', data: String(rnd(99999)), heightMm: 5 });
        else items.push({ kind: 'veg', xMm, yMm, type: rnd(2) ? 'veg' : 'nonveg', sizeMm: 6 });
      }
      const d = parseZpl(designToZpl(base(items)), { printerWidthDots: 864 });
      expect(d.issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(d.labels).toHaveLength(1);
      // Each item gives at least one element.
      expect(d.labels[0]?.elements.length).toBeGreaterThanOrEqual(items.length);
    }
  });
});

describe('veg symbols', () => {
  it('has the FSSAI minimum sizes', () => {
    expect(vegMinimums(35)).toEqual({ circleMm: 3, triangleMm: 2.5, squareMm: 6 });
    expect(vegMinimums(101)).toEqual({ circleMm: 4, triangleMm: 3.5, squareMm: 8 });
    expect(vegMinimums(501).squareMm).toBe(12);
    expect(vegMinimums(2501).squareMm).toBe(16);
  });

  it('draws veg as a square and a filled circle inside it', () => {
    const els = parseZpl(`^XA${vegSymbolZpl(10, 20, 48, 'veg')}^XZ`).labels[0]?.elements ?? [];
    expect(els).toHaveLength(2);
    expect(els[0]).toMatchObject({ kind: 'box', x: 10, y: 20, width: 48, height: 48 });
    const c = els[1];
    expect(c).toMatchObject({ kind: 'ellipse', width: 24, height: 24, thickness: 24 });
    // The circle is centred in the square.
    expect(c).toMatchObject({ x: 10 + 12, y: 20 + 12 });
  });

  it('draws non-veg as a square and a filled triangle made of bars that grow', () => {
    const els = parseZpl(`^XA${vegSymbolZpl(0, 0, 48, 'nonveg')}^XZ`).labels[0]?.elements ?? [];
    const bars = els.slice(1) as Array<{ kind: string; x: number; y: number; width: number; height: number }>;
    expect(bars.length).toBeGreaterThan(5);
    expect(bars.every((b) => b.kind === 'box')).toBe(true);
    for (let i = 1; i < bars.length; i++) expect((bars[i] as { width: number }).width).toBeGreaterThanOrEqual((bars[i - 1] as { width: number }).width);
    // Every bar is inside the square and centred on it.
    for (const b of bars) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(48);
      expect(Math.abs(b.x + b.width / 2 - 24)).toBeLessThanOrEqual(1);
    }
  });
});

describe('checkDesign', () => {
  it('is clean for a good design', () => {
    expect(checkDesign(base([{ kind: 'veg', xMm: 2, yMm: 2, type: 'veg', sizeMm: 6 }]))).toEqual([]);
  });
  it('flags an item outside the label', () => {
    expect(checkDesign(base([{ kind: 'text', xMm: 80, yMm: 2, text: 'x', heightMm: 3 }]))[0]).toMatchObject({ code: 'OUTSIDE', severity: 'error', item: 0 });
  });
  it('warns when a box or symbol goes past the edge', () => {
    expect(checkDesign(base([{ kind: 'box', xMm: 60, yMm: 2, widthMm: 20, heightMm: 5 }]))[0]).toMatchObject({ code: 'OUTSIDE', severity: 'warning' });
    expect(checkDesign(base([{ kind: 'veg', xMm: 66, yMm: 2, type: 'veg', sizeMm: 6 }]))[0]).toMatchObject({ code: 'OUTSIDE', severity: 'warning' });
  });
  it('warns when the veg symbol is under the FSSAI minimum', () => {
    expect(checkDesign(base([{ kind: 'veg', xMm: 2, yMm: 2, type: 'nonveg', sizeMm: 4 }]))[0]).toMatchObject({ code: 'VEG_SIZE' });
  });
  it('warns about rotated text', () => {
    expect(checkDesign(base([{ kind: 'text', xMm: 2, yMm: 2, text: 'x', heightMm: 3, rotation: 90 }]))[0]).toMatchObject({ code: 'ROTATION' });
  });
});

describe('more checks from the Zebra guide', () => {
  it('warns about text under 10 dots high', () => {
    expect(checkDesign(base([{ kind: 'text', xMm: 2, yMm: 2, text: 'x', heightMm: 1 }]))[0]).toMatchObject({ code: 'TEXT_SMALL' });
  });
  it('warns when a bar code is too close to the left edge for its quiet zone', () => {
    const near = checkDesign(base([{ kind: 'barcode', xMm: 1, yMm: 2, type: 'code128', data: '1', heightMm: 8 }]));
    expect(near[0]).toMatchObject({ code: 'QUIET_ZONE' });
    expect(checkDesign(base([{ kind: 'barcode', xMm: 4, yMm: 2, type: 'code128', data: '1', heightMm: 8 }]))).toEqual([]);
    // Wider bars need more space: 3 dots x 10 = 30 dots = 3.75 mm.
    expect(checkDesign(base([{ kind: 'barcode', xMm: 3, yMm: 2, type: 'code128', data: '1', heightMm: 8, moduleWidth: 3 }]))[0]).toMatchObject({ code: 'QUIET_ZONE' });
  });
});
