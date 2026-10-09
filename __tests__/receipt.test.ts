import ReceiptPrinterEncoder from '@point-of-sale/receipt-printer-encoder';
import { checkReceipt, cutBytes, ensureStructuredClone, isPrintable, layoutReceipt, receiptToBytes } from '../src/receipt';
import type { ReceiptBlock, ReceiptDesign, ReceiptLine } from '../src/receipt';

const paper = (columns = 32, cutter = true) => ({ columns, dotsWidth: 384, cutter });
const design = (blocks: ReceiptBlock[], columns = 32, cutter = true): ReceiptDesign => ({ paper: paper(columns, cutter), blocks });
const texts = (lines: ReceiptLine[]): string[] => lines.map((l) => (l.kind === 'text' ? l.text : `<${l.kind}>`));
const lay = (blocks: ReceiptBlock[], columns = 32): string[] => texts(layoutReceipt(design(blocks, columns)));
const hex = (u: Uint8Array): string => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');

describe('layout: text', () => {
  it('wraps at spaces', () => {
    expect(lay([{ kind: 'text', text: 'one two three four' }], 16)).toEqual(['one two three', 'four']);
  });
  it('cuts a word that is longer than the line', () => {
    expect(lay([{ kind: 'text', text: 'abcdefghijklmnopqrstuvwxyz0123456789' }], 16)).toEqual(['abcdefghijklmnop', 'qrstuvwxyz012345', '6789']);
  });
  it('keeps hard line breaks and wraps each part', () => {
    expect(lay([{ kind: 'text', text: 'a\n\nb' }])).toEqual(['a', '', 'b']);
  });
  it('centres with floor((width-len)/2) spaces and adds no trailing spaces', () => {
    expect(lay([{ kind: 'text', text: 'abc', align: 'center' }], 16)).toEqual(['      abc']);
  });
  it('aligns right', () => {
    expect(lay([{ kind: 'text', text: 'abc', align: 'right' }], 16)).toEqual(['             abc']);
  });
  it('does not pad a left line', () => {
    expect(lay([{ kind: 'text', text: 'abc' }], 16)).toEqual(['abc']);
  });
  it('size 2 uses half the columns', () => {
    const lines = layoutReceipt(design([{ kind: 'text', text: 'abcdefghij', size: 2, bold: true }], 16));
    expect(lines).toEqual([
      { kind: 'text', text: 'abcdefgh', bold: true, size: 2 },
      { kind: 'text', text: 'ij', bold: true, size: 2 },
    ]);
  });
  it('counts a code point as one column', () => {
    expect(lay([{ kind: 'text', text: 'éééééééééééééééééé' }], 16)).toEqual(['éééééééééééééééé', 'éé']);
  });
  it('shows a letter that cannot print as "?"', () => {
    expect(lay([{ kind: 'text', text: 'Rs ₹5 தமிழ்' }])).toEqual(['Rs ?5 ?????']);
  });
  it('removes control characters and turns a tab into a space', () => {
    expect(lay([{ kind: 'text', text: 'a\tb\u0007c\r\nd' }])).toEqual(['a bc', 'd']);
  });
});

describe('layout: row', () => {
  it('puts the right text at the right edge', () => {
    expect(lay([{ kind: 'row', left: 'Total', right: '186.00' }], 16)).toEqual(['Total     186.00']);
  });
  it('wraps the left text and puts the right text on the last line', () => {
    expect(lay([{ kind: 'row', left: 'Aavin toned milk pouch', right: '90.00' }], 20)).toEqual(['Aavin toned', 'milk pouch     90.00']);
  });
  it('puts a long right text on its own line', () => {
    expect(lay([{ kind: 'row', left: 'Total', right: 'x'.repeat(15) }], 16)).toEqual(['Total', ' '.repeat(1) + 'x'.repeat(15)]);
  });
  it('accepts an empty left or right text', () => {
    expect(lay([{ kind: 'row', left: '', right: '5' }], 16)).toEqual(['               5']);
    expect(lay([{ kind: 'row', left: 'abc', right: '' }], 16)).toEqual(['abc']);
  });
  it('uses half the columns at size 2', () => {
    expect(lay([{ kind: 'row', left: 'Tot', right: '9', size: 2 }], 16)).toEqual(['Tot    9']);
  });
});

describe('layout: rule, feed, cut', () => {
  it('makes the three rules', () => {
    expect(lay([{ kind: 'rule' }, { kind: 'rule', style: 'double' }, { kind: 'rule', style: 'dashed' }], 17)).toEqual([
      '-'.repeat(17),
      '='.repeat(17),
      '- - - - - - - - -',
    ]);
  });
  it('feeds empty lines', () => {
    expect(lay([{ kind: 'feed', lines: 3 }])).toEqual(['', '', '']);
  });
  it('cuts with a cutter', () => {
    expect(layoutReceipt(design([{ kind: 'cut', mode: 'full' }]))).toEqual([{ kind: 'cut', mode: 'full', fed: false }]);
    expect(layoutReceipt(design([{ kind: 'cut' }]))).toEqual([{ kind: 'cut', mode: 'partial', fed: false }]);
  });
  it('says the paper was fed when there is no cutter', () => {
    expect(layoutReceipt(design([{ kind: 'cut' }], 32, false))).toEqual([{ kind: 'cut', mode: 'partial', fed: true }]);
  });
  it('gives qr and barcode their defaults', () => {
    expect(layoutReceipt(design([{ kind: 'qr', data: 'x' }, { kind: 'barcode', data: '123' }]))).toEqual([
      { kind: 'qr', data: 'x', cell: 5, align: 'center' },
      { kind: 'barcode', data: '123', height: 64, showText: true, align: 'center' },
    ]);
  });
});

describe('layout: table', () => {
  const cols = [
    { width: 'auto' as const, align: 'left' as const },
    { width: 3, align: 'right' as const },
    { width: 7, align: 'right' as const },
  ];
  it('gives the auto column the rest, wraps cells and makes the row as tall as the tallest cell', () => {
    const out = lay(
      [{ kind: 'table', columns: cols, header: ['Item', 'Qty', 'Amount'], rows: [['Basmati rice long grain', '2', '96.00'], ['Milk', '3', '90.00']] }],
      32
    );
    expect(out).toEqual([
      'Item                 Qty  Amount',
      'Basmati rice long      2   96.00',
      'grain',
      'Milk                   3   90.00',
    ]);
  });
  it('marks the header bold and the rows by the table flag', () => {
    const lines = layoutReceipt(design([{ kind: 'table', columns: cols, header: ['a', 'b', 'c'], rows: [['x', '1', '2']], bold: false }]));
    expect(lines.map((l) => l.kind === 'text' && l.bold)).toEqual([true, false]);
    const all = layoutReceipt(design([{ kind: 'table', columns: cols, rows: [['x', '1', '2']], bold: true }]));
    expect(all.map((l) => l.kind === 'text' && l.bold)).toEqual([true]);
  });
  it('splits a cell on a line break first, then wraps each part inside the column', () => {
    const out = lay(
      [
        {
          kind: 'table',
          columns: [{ width: 'auto', align: 'left' }, { width: 6, align: 'right' }],
          rows: [['Basmati Rice\nHSN 1006 · GST 5%', '96.00']],
        },
      ],
      24
    );
    expect(out).toEqual(['Basmati Rice       96.00', 'HSN 1006 · GST 5%']);
    const narrow = lay([{ kind: 'table', columns: [{ width: 10, align: 'left' }], rows: [['Rice\nHSN 1006 GST 5%']] }], 24);
    expect(narrow).toEqual(['Rice', 'HSN 1006', 'GST 5%']);
  });
  it('allows a line break in a header cell', () => {
    const out = lay([{ kind: 'table', columns: [{ width: 8, align: 'left' }, { width: 6, align: 'right' }], header: ['Item\nname', 'Amt'], rows: [] }], 24);
    expect(out).toEqual(['Item        Amt', 'name']);
  });
  it('aligns centre inside the column and keeps empty cells', () => {
    const out = lay([{ kind: 'table', columns: [{ width: 6, align: 'center' }, { width: 4, align: 'right' }], rows: [['ab', ''], ['', '7']] }]);
    expect(out).toEqual(['  ab', '          7']);
  });
  it('does not throw for a table that is too wide, and shrinks it to the paper', () => {
    const lines = lay([{ kind: 'table', columns: [{ width: 30, align: 'left' }, { width: 30, align: 'left' }], rows: [['a'.repeat(40), 'b']] }]);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(32);
  });
});

describe('checkReceipt', () => {
  const check = (blocks: ReceiptBlock[], p = paper()) => checkReceipt({ paper: p, blocks });
  it('is empty for a good design', () => {
    expect(check([{ kind: 'text', text: 'Hello é' }, { kind: 'qr', data: 'x', cell: 4 }, { kind: 'barcode', data: 'AB12', height: 80 }, { kind: 'feed', lines: 2 }])).toEqual([]);
  });
  it('names the letters that cannot print', () => {
    const [i] = check([{ kind: 'row', left: 'Rs ₹', right: 'த' }]);
    expect(i).toEqual({
      severity: 'warning',
      code: 'unprintable',
      message: 'These letters cannot be printed and print as "?": ₹ த',
      blockIndex: 0,
    });
  });
  it('looks into table cells', () => {
    const [i] = check([{ kind: 'text', text: 'a' }, { kind: 'table', columns: [{ width: 5, align: 'left' }], rows: [['₹']] }]);
    expect(i).toMatchObject({ code: 'unprintable', blockIndex: 1 });
  });
  it('knows which letters print', () => {
    expect(isPrintable('a'.charCodeAt(0))).toBe(true);
    expect(isPrintable('é'.charCodeAt(0))).toBe(true);
    expect(isPrintable('€'.charCodeAt(0))).toBe(true);
    expect(isPrintable(0x20b9)).toBe(false);
    expect(isPrintable(0x0ba4)).toBe(false);
    expect(isPrintable(0x1f600)).toBe(false);
    expect(isPrintable(9)).toBe(false);
  });
  it('reports a table that is too wide', () => {
    const issues = check([{ kind: 'table', columns: [{ width: 20, align: 'left' }, { width: 20, align: 'left' }], rows: [] }]);
    expect(issues.map((i) => i.code)).toEqual(['too_wide']);
  });
  it('reports an auto column that gets under 4 characters', () => {
    const issues = check([{ kind: 'table', columns: [{ width: 'auto', align: 'left' }, { width: 28, align: 'left' }], rows: [] }]);
    expect(issues.map((i) => i.code)).toEqual(['bad_value']);
  });
  it('reports numbers out of range', () => {
    const issues = check([
      { kind: 'feed', lines: 11 },
      { kind: 'qr', data: 'x', cell: 9 },
      { kind: 'barcode', data: 'x', height: 10 },
    ]);
    expect(issues.map((i) => [i.code, i.blockIndex])).toEqual([['bad_value', 0], ['bad_value', 1], ['bad_value', 2]]);
    const paperIssues = checkReceipt({ paper: { columns: 80, dotsWidth: 100, cutter: true }, blocks: [] });
    expect(paperIssues.map((i) => i.code)).toEqual(['bad_value', 'bad_value']);
    expect(paperIssues[0]?.message).toContain('16 to 48');
  });
  it('reports a barcode with letters that Code 128 cannot hold', () => {
    expect(check([{ kind: 'barcode', data: 'ab₹' }]).map((i) => i.code)).toEqual(['bad_value']);
  });
  it('uses plain numbers inside the range after a warning', () => {
    expect(layoutReceipt(design([{ kind: 'feed', lines: 99 }])).length).toBe(10);
    expect(layoutReceipt(design([{ kind: 'barcode', data: 'x', height: 10 }]))[0]).toMatchObject({ height: 40 });
  });
});

describe('printable letters', () => {
  it('equals what the encoder prints without "?" (its own code page choice)', () => {
    ensureStructuredClone();
    const points: number[] = [];
    for (let c = 0x80; c <= 0x45f; c++) points.push(c);
    for (let c = 0xe00; c <= 0xe7f; c++) points.push(c);
    for (let c = 0x2010; c <= 0x20bf; c++) points.push(c);
    const enc = new ReceiptPrinterEncoder({ language: 'esc-pos', columns: 48, newline: '\n' }).initialize().codepage('auto');
    for (const c of points) enc.text(String.fromCodePoint(c)).newline();
    // After the init bytes: ESC t n (select code page, 3 bytes) sometimes, then one letter byte and a line feed.
    const bytes = enc.encode();
    const letters: number[] = [];
    for (let i = 7; i < bytes.length; i++) {
      if (bytes[i] === 0x1b && bytes[i + 1] === 0x74) i += 3;
      letters.push(bytes[i] as number);
      i += 1; // the line feed after the letter
    }
    expect(letters.length).toBe(points.length);
    // 0x3f means the encoder found no code page for the letter.
    const printed = points.filter((_, i) => letters[i] !== 0x3f);
    expect(points.filter((c) => isPrintable(c))).toEqual(printed);
  });
});

describe('bytes', () => {
  it('an empty design is the initialize bytes only', () => {
    expect(hex(receiptToBytes(design([])))).toBe('1b401c2e1b4d00');
  });

  it('golden bytes of a small receipt', () => {
    const bytes = receiptToBytes(
      design([
        { kind: 'text', text: 'SHOP', align: 'center', bold: true, size: 2 },
        { kind: 'row', left: 'Total', right: '186.00' },
        { kind: 'qr', data: 'abc' },
        { kind: 'barcode', data: '12345' },
        { kind: 'cut' },
      ])
    );
    expect(hex(bytes)).toBe(
      [
        '1b401c2e1b4d00', // initialize
        '1b45011d2111', // bold on, size 2x2
        '1b740020202020202053484f50', // code page 0, 6 spaces, "SHOP"
        '1d21001b4500', // size 1, bold off
        '0a', // line feed
        '546f74616c2020202020202020202020202020202020202020203138362e3030', // "Total" ... "186.00"
        '0a',
        '1b6101', // centre
        '1d286b0400314132001d286b03003143051d286b03003145311d286b06003150306162631d286b0300315130', // QR: model 2, cell 5, level m, data "abc", print
        '0a1b61001b6101', // feed, left, centre
        '1d68401d77031d48021d6b49077b4231323334350a', // barcode height 64, text below, code 128 "12345"
        '1b61001d564200', // left, GS V 66 0 (feed to the cutter, partial cut)
      ].join('')
    );
  });

  it('cuts with GS V 66 0: feed to the cutter, then a partial cut (the vendor tool sends the same bytes)', () => {
    expect(hex(receiptToBytes(design([{ kind: 'cut' }])))).toBe('1b401c2e1b4d00' + '1d564200');
  });

  it('a full cut is GS V 65 0', () => {
    expect(hex(receiptToBytes(design([{ kind: 'cut', mode: 'full' }])))).toBe('1b401c2e1b4d00' + '1d564100');
  });

  it('cutBytes: function B, never the plain cut that does not feed to the cutter', () => {
    expect(cutBytes('partial')).toEqual([0x1d, 0x56, 66, 0]);
    expect(cutBytes('full')).toEqual([0x1d, 0x56, 65, 0]);
  });

  it('sends no cut command when the paper has no cutter', () => {
    expect(hex(receiptToBytes(design([{ kind: 'cut' }], 32, false)))).not.toContain('1d56');
  });

  it('feeds four lines when the paper has no cutter', () => {
    const bytes = receiptToBytes(design([{ kind: 'cut' }], 32, false));
    expect(hex(bytes)).toBe('1b401c2e1b4d00' + '0a0a0a0a');
  });

  it('prints a letter from a code page, and "?" for a letter that no page holds', () => {
    const b = receiptToBytes(design([{ kind: 'text', text: 'é' }]));
    expect(hex(b)).toBe('1b401c2e1b4d00' + '1b7400' + '82' + '0a');
    const q = receiptToBytes(design([{ kind: 'text', text: '₹' }]));
    expect(hex(q)).toBe('1b401c2e1b4d00' + '1b7400' + '3f' + '0a');
  });

  it('works when the platform has no structuredClone (Hermes)', () => {
    const g = globalThis as { structuredClone?: unknown };
    const saved = g.structuredClone;
    const blocks: ReceiptBlock[] = [{ kind: 'text', text: 'é bold', bold: true }, { kind: 'cut' }];
    const withIt = hex(receiptToBytes(design(blocks)));
    try {
      delete g.structuredClone;
      expect(hex(receiptToBytes(design(blocks)))).toBe(withIt);
      expect(typeof g.structuredClone).toBe('function');
    } finally {
      g.structuredClone = saved;
    }
  });

  it('ensureStructuredClone keeps a global that exists', () => {
    const g = globalThis as { structuredClone?: unknown };
    const before = g.structuredClone;
    ensureStructuredClone();
    expect(g.structuredClone).toBe(before);
  });
});

/** Decode the text of the simple commands (text, bold, size, code page, init). Enough for blocks that hold ASCII text only. */
function decodeAscii(bytes: Uint8Array): string[] {
  const lines: string[] = [];
  let cur = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    if (b === 0x1b) i += (bytes[i + 1] === 0x40 ? 1 : 2); // ESC @ / ESC E n / ESC t n / ESC M n
    else if (b === 0x1c) i += 1; // FS . (cancel Kanji mode)
    else if (b === 0x1d) i += 2; // GS ! n
    else if (b === 0x0a) {
      lines.push(cur);
      cur = '';
    } else cur += String.fromCharCode(b);
  }
  return lines;
}

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

describe('the preview is the print', () => {
  it('decodes to the laid-out text for random ASCII blocks', () => {
    const r = rng(7);
    const word = (): string => {
      const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789.,-/%';
      let w = '';
      for (let n = 1 + Math.floor(r() * 12); n > 0; n--) w += alphabet[Math.floor(r() * alphabet.length)];
      return w;
    };
    const phrase = (): string => Array.from({ length: Math.floor(r() * 9) }, word).join(r() < 0.1 ? '  ' : ' ');
    for (let round = 0; round < 60; round++) {
      const columns = 16 + Math.floor(r() * 33);
      const blocks: ReceiptBlock[] = [];
      for (let k = 0; k < 6; k++) {
        const pick = Math.floor(r() * 5);
        const size = r() < 0.3 ? 2 : 1;
        if (pick === 0) blocks.push({ kind: 'text', text: phrase() + (r() < 0.3 ? '\n' + phrase() : ''), align: (['left', 'center', 'right'] as const)[Math.floor(r() * 3)] as 'left', bold: r() < 0.3, size });
        else if (pick === 1) blocks.push({ kind: 'row', left: phrase(), right: word(), bold: r() < 0.3, size });
        else if (pick === 2) blocks.push({ kind: 'rule', style: (['single', 'double', 'dashed'] as const)[Math.floor(r() * 3)] as 'single' });
        else if (pick === 3) blocks.push({ kind: 'feed', lines: 1 + Math.floor(r() * 3) });
        else blocks.push({ kind: 'table', columns: [{ width: 'auto', align: 'left' }, { width: 5, align: 'right' }], header: ['H', 'Q'], rows: [[phrase(), word().slice(0, 5)], [phrase() + '\n' + word(), '1']] });
      }
      const d = design(blocks, columns);
      const expected = texts(layoutReceipt(d));
      expect(decodeAscii(receiptToBytes(d))).toEqual(expected);
      for (const l of layoutReceipt(d)) {
        if (l.kind === 'text') expect(l.text.length).toBeLessThanOrEqual(l.size === 2 ? Math.floor(columns / 2) : columns);
      }
    }
  });
});

describe('garbage input', () => {
  it('never throws', () => {
    const r = rng(99);
    const junk = [undefined, null, 0, -5, 1e9, NaN, 'x', '', 'a'.repeat(300), '\n\n', '😀', '₹த', {}, [], ['a', 5], true];
    const any = (): unknown => junk[Math.floor(r() * junk.length)];
    const kinds = ['text', 'row', 'rule', 'feed', 'table', 'qr', 'barcode', 'cut', 'nope', undefined];
    for (let n = 0; n < 300; n++) {
      const blocks = Array.from({ length: Math.floor(r() * 6) }, () => {
        const b: Record<string, unknown> = { kind: kinds[Math.floor(r() * kinds.length)] };
        for (const k of ['text', 'left', 'right', 'align', 'bold', 'size', 'style', 'lines', 'data', 'cell', 'height', 'showText', 'mode', 'header', 'rows', 'columns']) {
          if (r() < 0.5) b[k] = any();
        }
        if (r() < 0.3) b.columns = [{ width: any(), align: any() }, { width: 'auto', align: 'left' }, { width: 'auto', align: 'left' }];
        if (r() < 0.3) b.rows = [[any(), any()], any()];
        return b;
      });
      const d = { paper: r() < 0.2 ? any() : { columns: any(), dotsWidth: any(), cutter: any() }, blocks: r() < 0.1 ? any() : blocks } as unknown as ReceiptDesign;
      expect(() => {
        layoutReceipt(d);
        checkReceipt(d);
        receiptToBytes(d);
      }).not.toThrow();
    }
    expect(() => layoutReceipt(null as unknown as ReceiptDesign)).not.toThrow();
  });
});
