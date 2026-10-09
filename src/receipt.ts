/**
 * Thermal receipt printing (ESC/POS). Pure TypeScript. The caller fills a `ReceiptDesign` (text, rows, tables, QR, barcode, cut).
 * `layoutReceipt` gives the lines as they print (for a preview). `receiptToBytes` gives the ESC/POS bytes.
 * Both use the same layout, so the preview is the print.
 *
 * Limits:
 * - Nothing in this file is checked on a printer. Only unit tests ran.
 * - The text goes out as single-byte code pages. Letters in no code page (the rupee sign, Tamil) print as "?".
 *   The layout already shows them as "?". `checkReceipt` names them.
 * - The encoder accepts 32, 35, 42, 44 or 48 columns. So the paper is 16 to 48 columns here.
 * - The encoder library needs `structuredClone`. Hermes may not have it. See `ensureStructuredClone`.
 * See docs/RECEIPT.md.
 */
import CodepageEncoder from '@point-of-sale/codepage-encoder';
import ReceiptPrinterEncoder from '@point-of-sale/receipt-printer-encoder';
import type { Codepage } from '@point-of-sale/codepage-encoder';

export type ReceiptAlign = 'left' | 'center' | 'right';

/** `columns`: characters of the normal font, 16 to 48. `dotsWidth`: print width in dots, 192 to 832. */
export interface ReceiptPaper {
  columns: number;
  dotsWidth: number;
  cutter: boolean;
}

export type ReceiptBlock =
  | { kind: 'text'; text: string; align?: ReceiptAlign; bold?: boolean; size?: 1 | 2 }
  | { kind: 'row'; left: string; right: string; bold?: boolean; size?: 1 | 2 }
  | { kind: 'rule'; style?: 'single' | 'double' | 'dashed' }
  | { kind: 'feed'; lines: number }
  | {
      kind: 'table';
      columns: { width: number | 'auto'; align: ReceiptAlign }[];
      header?: string[];
      rows: string[][];
      bold?: boolean;
    }
  | { kind: 'qr'; data: string; cell?: number; align?: ReceiptAlign }
  | { kind: 'barcode'; data: string; height?: number; showText?: boolean; align?: ReceiptAlign }
  | { kind: 'cut'; mode?: 'partial' | 'full' };

export interface ReceiptDesign {
  paper: ReceiptPaper;
  blocks: ReceiptBlock[];
}

export type ReceiptLine =
  | { kind: 'text'; text: string; bold: boolean; size: 1 | 2 }
  | { kind: 'qr'; data: string; cell: number; align: ReceiptAlign }
  | { kind: 'barcode'; data: string; height: number; showText: boolean; align: ReceiptAlign }
  | { kind: 'cut'; mode: 'partial' | 'full'; fed: boolean };

export interface ReceiptIssue {
  severity: 'warning';
  code: 'unprintable' | 'too_wide' | 'bad_value';
  message: string;
  blockIndex: number;
}

/** The paper widths the encoder library accepts for ESC/POS. */
const ENCODER_COLUMNS = [32, 35, 42, 44, 48];
export const RECEIPT_MIN_COLUMNS = 16;
export const RECEIPT_MAX_COLUMNS = 48;
const EMPTY_CELLS_AUTO_MIN = 4;
const FEED_AFTER_CUT_WITHOUT_CUTTER = 4;

/**
 * The cut. A receipt printer cuts at its cutter, which sits behind the print head (Epson's TM-T88 class: about 14 mm). A plain cut
 * (`GS V 0` / `GS V 1`, "function A") cuts where the cutter is NOW, so the last centimetres of what was printed are still between the head
 * and the cutter and fall on the wrong side: on the owner's SPRT SP-POS894UED the QR code of a test receipt came out on the next piece.
 * `GS V 65 n` / `GS V 66 n` ("function B") first feeds the paper until the last printed line has reached the cutter, then cuts, so the
 * printer's own firmware uses its own distance. Epson ESC/POS reference, `GS V`. The vendor's Setting Tool for this printer family sends
 * `1D 56 42 00` (function B, partial) in its own cut (found in the tool's code, 2026-10-09).
 * 65 is a full cut and 66 a partial cut (one point left uncut); `n` is extra feed after the cutting position, 0 here (the template's own
 * `feed` block gives the empty space under the last line). NOT checked on the printer after this change.
 */
export function cutBytes(mode: 'partial' | 'full'): number[] {
  return [0x1d, 0x56, mode === 'full' ? 65 : 66, 0];
}

/**
 * The code pages the encoder may use. This is the "epson" list of the encoder 4.0.1 (the generic profile).
 * The same list goes to the encoder and to the printable check, so they cannot disagree.
 * A test compares this list with the encoder's own choice.
 */
export const RECEIPT_CODEPAGES: readonly Codepage[] = [
  'cp437', 'epson/katakana', 'cp850', 'cp860', 'cp863', 'cp865', 'cp851', 'cp853', 'cp857', 'cp737', 'iso8859-7',
  'windows1252', 'cp866', 'cp852', 'cp858', 'thai42', 'thai11', 'thai13', 'tcvn3', 'tcvn3capitals', 'cp720', 'cp775',
  'cp855', 'cp861', 'cp862', 'cp864', 'cp869', 'epson/iso8859-2', 'iso8859-15', 'cp1098', 'cp774', 'cp772', 'cp1125',
  'windows1250', 'windows1251', 'windows1253', 'windows1254', 'windows1255', 'windows1256', 'windows1257',
  'windows1258', 'rk1048',
];

// ---------------------------------------------------------------------------------------------------------------------
// structuredClone

type CloneGlobal = { structuredClone?: unknown };

/** A deep copy of plain data: primitives, arrays (holes stay), plain objects, typed arrays. Enough for the encoder's tables. */
function cloneData<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => cloneData(v)) as unknown as T; // cast: T is an array here
  if (ArrayBuffer.isView(value)) return (value as unknown as Uint8Array).slice() as unknown as T; // cast: typed array
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>)) out[k] = cloneData((value as Record<string, unknown>)[k]);
  return out as T;
}

/**
 * The encoder library calls `structuredClone` on its normal path: in the TextStyle constructor (each new encoder) and in
 * `CodepageEncoder.getEncoding` (each code page lookup). Node has it. Hermes in React Native may not.
 * When the global is missing, this sets one that copies plain data. It never replaces a global that exists.
 */
export function ensureStructuredClone(): void {
  const g = globalThis as CloneGlobal;
  if (typeof g.structuredClone !== 'function') g.structuredClone = cloneData;
}

// ---------------------------------------------------------------------------------------------------------------------
// printable characters

let printableSet: Set<number> | null = null;

/** Can this code point print without becoming "?"? ASCII, or a character that one of the encoder's code pages holds. */
export function isPrintable(cp: number): boolean {
  if (cp >= 0x20 && cp <= 0x7e) return true;
  if (cp < 0x20 || cp === 0x7f) return false;
  if (printableSet === null) {
    ensureStructuredClone();
    const set = new Set<number>();
    for (const page of RECEIPT_CODEPAGES) {
      for (const c of CodepageEncoder.getEncoding(page).codepoints) {
        if (typeof c === 'number' && c > 0x7f) set.add(c);
      }
    }
    printableSet = set;
  }
  return printableSet.has(cp);
}

// ---------------------------------------------------------------------------------------------------------------------
// small helpers

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function inRange(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= min && value <= max;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

/** One entry for each code point. Line breaks stay as "\n". Tabs become a space. Other control characters go. */
function normalize(text: string): string {
  return str(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    // eslint-disable-next-line no-control-regex -- control characters must not reach the printer as text
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '');
}

/** The text as the printer prints it: a letter that no code page holds becomes "?". */
function printableText(text: string): string {
  let out = '';
  for (const ch of Array.from(text)) out += ch === '\n' || isPrintable(ch.codePointAt(0) ?? 0) ? ch : '?';
  return out;
}

function len(s: string): number {
  return Array.from(s).length;
}

function cut(s: string, from: number, to?: number): string {
  return Array.from(s).slice(from, to).join('');
}

/** Word wrap at spaces. A word longer than `width` is cut hard. Always returns at least one line. No trailing spaces. */
function wrap(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const lines: string[] = [];
  let cur = '';
  let curLen = 0;
  let started = false;
  const flush = (): void => {
    lines.push(cur.replace(/ +$/, ''));
    cur = '';
    curLen = 0;
    started = false;
  };
  for (const word of text.split(' ')) {
    let rest = word;
    let restLen = len(rest);
    if (started && curLen + 1 + restLen <= w) {
      cur += ' ' + rest;
      curLen += 1 + restLen;
      continue;
    }
    if (started) flush();
    while (restLen > w) {
      lines.push(cut(rest, 0, w));
      rest = cut(rest, w);
      restLen -= w;
    }
    cur = rest;
    curLen = restLen;
    started = true;
  }
  flush();
  return lines;
}

function wrapLines(text: string, width: number): string[] {
  return normalize(text)
    .split('\n')
    .flatMap((part) => wrap(part, width));
}

function align(line: string, width: number, how: ReceiptAlign): string {
  const n = len(line);
  if (how === 'right') return ' '.repeat(Math.max(0, width - n)) + line;
  if (how === 'center') return ' '.repeat(Math.max(0, Math.floor((width - n) / 2))) + line;
  return line;
}

/** Pad a line on the right to `width` (inside a table cell, so the next cell starts at its column). */
function padCell(line: string, width: number, how: ReceiptAlign): string {
  const n = len(line);
  const total = Math.max(0, width - n);
  if (how === 'right') return ' '.repeat(total) + line;
  if (how === 'center') {
    const left = Math.floor(total / 2);
    return ' '.repeat(left) + line + ' '.repeat(total - left);
  }
  return line + ' '.repeat(total);
}

// ---------------------------------------------------------------------------------------------------------------------
// layout

interface Laid {
  line: ReceiptLine;
  blockIndex: number;
}

interface Built {
  lines: Laid[];
  issues: ReceiptIssue[];
}

function paperColumns(design: ReceiptDesign): number {
  return clampInt(design?.paper?.columns, RECEIPT_MIN_COLUMNS, RECEIPT_MAX_COLUMNS, RECEIPT_MAX_COLUMNS);
}

function textLine(text: string, bold: boolean, size: 1 | 2): ReceiptLine {
  return { kind: 'text', text, bold, size };
}

function sizeOf(value: unknown): 1 | 2 {
  return value === 2 ? 2 : 1;
}

function alignOf(value: unknown, fallback: ReceiptAlign): ReceiptAlign {
  return value === 'left' || value === 'center' || value === 'right' ? value : fallback;
}

function layoutRow(left: string, right: string, width: number): string[] {
  const l = normalize(left).replace(/\n/g, ' ');
  const r = normalize(right).replace(/\n/g, ' ');
  if (r === '') return wrap(l, width);
  if (l === '') return wrap(r, width).map((x) => align(x, width, 'right'));
  const rl = len(r);
  if (len(l) + 1 + rl <= width) return [l + ' '.repeat(width - len(l) - rl) + r];
  // The right text needs at least one column for the left text and one space between them.
  if (rl > width - 2) return [...wrap(l, width), ...wrap(r, width).map((x) => align(x, width, 'right'))];
  const parts = wrap(l, width - rl - 1);
  const last = parts.pop() ?? '';
  return [...parts, last + ' '.repeat(width - len(last) - rl) + r];
}

/** Shrink the widest columns by one until the row fits. Columns never go under 1. */
function shrinkToFit(widths: number[], total: number): void {
  let sum = widths.reduce((a, b) => a + b, 0);
  while (sum > total) {
    let at = 0;
    widths.forEach((w, i) => {
      if (w > (widths[at] ?? 0)) at = i;
    });
    if ((widths[at] ?? 0) <= 1) return;
    widths[at] = (widths[at] ?? 1) - 1;
    sum -= 1;
  }
}

function layoutTable(
  block: Extract<ReceiptBlock, { kind: 'table' }>,
  width: number,
  index: number,
  issues: ReceiptIssue[]
): ReceiptLine[] {
  const cols = Array.isArray(block.columns) ? block.columns : [];
  if (cols.length === 0) {
    issues.push({ severity: 'warning', code: 'bad_value', message: 'A table needs at least one column.', blockIndex: index });
    return [];
  }
  const gaps = cols.length - 1;
  const widths: number[] = [];
  let autoAt = -1;
  let fixed = 0;
  cols.forEach((c, i) => {
    if (c?.width === 'auto') {
      if (autoAt === -1) {
        autoAt = i;
        widths.push(0);
        return;
      }
      issues.push({ severity: 'warning', code: 'bad_value', message: 'A table can have one "auto" column only. The others get width 8.', blockIndex: index });
      widths.push(8);
      fixed += 8;
      return;
    }
    if (!inRange(c?.width, 1, 80)) {
      issues.push({ severity: 'warning', code: 'bad_value', message: `A column width must be a whole number from 1 to 80. Got ${str(c?.width)}.`, blockIndex: index });
    }
    const w = clampInt(c?.width, 1, 80, 8);
    widths.push(w);
    fixed += w;
  });
  if (autoAt === -1 && fixed + gaps > width) {
    issues.push({
      severity: 'warning',
      code: 'too_wide',
      message: `The table columns need ${fixed + gaps} characters. The paper has ${width}. The columns are made narrower.`,
      blockIndex: index,
    });
  }
  if (autoAt !== -1) {
    const auto = width - fixed - gaps;
    if (auto < EMPTY_CELLS_AUTO_MIN) {
      issues.push({
        severity: 'warning',
        code: 'bad_value',
        message: `The "auto" column would get ${auto} characters. It needs at least ${EMPTY_CELLS_AUTO_MIN}. Use narrower fixed columns.`,
        blockIndex: index,
      });
    }
    widths[autoAt] = Math.max(1, auto);
  }
  shrinkToFit(widths, width - gaps);

  const out: ReceiptLine[] = [];
  const emitRow = (cells: unknown[], bold: boolean): void => {
    const wrapped = widths.map((w, i) => wrapLines(str(cells[i]), w));
    const height = Math.max(1, ...wrapped.map((c) => c.length));
    for (let y = 0; y < height; y++) {
      const text = wrapped
        .map((cell, i) => padCell(cell[y] ?? '', widths[i] ?? 1, alignOf(cols[i]?.align, 'left')))
        .join(' ')
        .replace(/ +$/, '');
      out.push(textLine(text, bold, 1));
    }
  };
  const bold = block.bold === true;
  if (Array.isArray(block.header)) emitRow(block.header, true);
  for (const row of Array.isArray(block.rows) ? block.rows : []) {
    const cells = Array.isArray(row) ? row : [];
    if (cells.length > cols.length) {
      issues.push({ severity: 'warning', code: 'bad_value', message: `A table row has ${cells.length} cells. The table has ${cols.length} columns. The extra cells are not printed.`, blockIndex: index });
    }
    emitRow(cells, bold);
  }
  return out;
}

/** All the source text of a block, to look for letters that cannot print. */
function sourceTexts(block: ReceiptBlock): string[] {
  switch (block.kind) {
    case 'text':
      return [str(block.text)];
    case 'row':
      return [str(block.left), str(block.right)];
    case 'table':
      return [
        ...(Array.isArray(block.header) ? block.header.map(str) : []),
        ...(Array.isArray(block.rows) ? block.rows.flatMap((r) => (Array.isArray(r) ? r.map(str) : [])) : []),
      ];
    default:
      return [];
  }
}

function build(design: ReceiptDesign): Built {
  const lines: Laid[] = [];
  const issues: ReceiptIssue[] = [];
  const paper = design?.paper;
  const width = paperColumns(design);
  if (!inRange(paper?.columns, RECEIPT_MIN_COLUMNS, RECEIPT_MAX_COLUMNS)) {
    issues.push({
      severity: 'warning',
      code: 'bad_value',
      message: `The paper columns must be a whole number from ${RECEIPT_MIN_COLUMNS} to ${RECEIPT_MAX_COLUMNS}. Got ${str(paper?.columns)}. ${width} is used.`,
      blockIndex: -1,
    });
  }
  if (!inRange(paper?.dotsWidth, 192, 832)) {
    issues.push({ severity: 'warning', code: 'bad_value', message: `The paper width in dots must be a whole number from 192 to 832. Got ${str(paper?.dotsWidth)}.`, blockIndex: -1 });
  }
  const cutter = paper?.cutter === true;
  const blocks = Array.isArray(design?.blocks) ? design.blocks : [];

  blocks.forEach((raw, index) => {
    const block = raw as ReceiptBlock | null;
    const push = (...ls: ReceiptLine[]): void => {
      for (const line of ls) lines.push({ line, blockIndex: index });
    };
    const warn = (code: ReceiptIssue['code'], message: string): void => {
      issues.push({ severity: 'warning', code, message, blockIndex: index });
    };
    if (block === null || typeof block !== 'object') {
      warn('bad_value', 'This block is not an object.');
      return;
    }

    // Letters that cannot print.
    const bad = new Set<string>();
    for (const t of sourceTexts(block)) {
      for (const ch of Array.from(normalize(t))) {
        if (ch !== '\n' && !isPrintable(ch.codePointAt(0) ?? 0)) bad.add(ch);
      }
    }
    if (bad.size > 0) warn('unprintable', `These letters cannot be printed and print as "?": ${Array.from(bad).join(' ')}`);

    switch (block.kind) {
      case 'text': {
        const size = sizeOf(block.size);
        const w = size === 2 ? Math.floor(width / 2) : width;
        const how = alignOf(block.align, 'left');
        for (const t of wrapLines(block.text, w)) push(textLine(printableText(align(t, w, how)), block.bold === true, size));
        break;
      }
      case 'row': {
        const size = sizeOf(block.size);
        const w = size === 2 ? Math.floor(width / 2) : width;
        for (const t of layoutRow(block.left, block.right, w)) push(textLine(printableText(t), block.bold === true, size));
        break;
      }
      case 'rule': {
        const t = block.style === 'double' ? '=' : block.style === 'dashed' ? '- ' : '-';
        push(textLine(cut(t.repeat(width), 0, width).replace(/ +$/, ''), false, 1));
        break;
      }
      case 'feed': {
        if (!inRange(block.lines, 1, 10)) warn('bad_value', `Feed lines must be a whole number from 1 to 10. Got ${str(block.lines)}.`);
        const n = clampInt(block.lines, 1, 10, 1);
        for (let i = 0; i < n; i++) push(textLine('', false, 1));
        break;
      }
      case 'table': {
        for (const l of layoutTable(block, width, index, issues)) {
          if (l.kind === 'text') push(textLine(printableText(l.text), l.bold, l.size));
        }
        break;
      }
      case 'qr': {
        if (block.cell !== undefined && !inRange(block.cell, 3, 8)) warn('bad_value', `The QR cell size must be a whole number from 3 to 8. Got ${str(block.cell)}.`);
        if (str(block.data) === '') warn('bad_value', 'The QR code has no data.');
        push({ kind: 'qr', data: str(block.data), cell: clampInt(block.cell, 3, 8, 5), align: alignOf(block.align, 'center') });
        break;
      }
      case 'barcode': {
        if (block.height !== undefined && !inRange(block.height, 40, 120)) warn('bad_value', `The barcode height must be a whole number from 40 to 120 dots. Got ${str(block.height)}.`);
        const data = str(block.data);
        // eslint-disable-next-line no-control-regex -- Code 128 holds ASCII 0 to 127 only; printable ASCII is what this module allows
        if (data === '' || /[^ -~]/.test(data)) warn('bad_value', 'A barcode needs text with plain ASCII letters, digits and signs only.');
        push({
          kind: 'barcode',
          data: data.replace(/[^ -~]/g, ''),
          height: clampInt(block.height, 40, 120, 64),
          showText: block.showText !== false,
          align: alignOf(block.align, 'center'),
        });
        break;
      }
      case 'cut': {
        push({ kind: 'cut', mode: block.mode === 'full' ? 'full' : 'partial', fed: !cutter });
        break;
      }
      default:
        warn('bad_value', `Unknown block kind "${str((block as { kind?: unknown }).kind)}".`);
    }
  });
  return { lines, issues };
}

/** The lines as they print. One entry for each printed line (text), or each QR code, barcode or cut. */
export function layoutReceipt(design: ReceiptDesign): ReceiptLine[] {
  return build(design).lines.map((l) => l.line);
}

/** Warnings about a design. Never throws. A design with warnings still lays out and prints. */
export function checkReceipt(design: ReceiptDesign): ReceiptIssue[] {
  return build(design).issues;
}

// ---------------------------------------------------------------------------------------------------------------------
// bytes

/** The smallest paper width that the encoder accepts and that is not narrower than ours. */
function encoderColumns(columns: number): number {
  return ENCODER_COLUMNS.find((c) => c >= columns) ?? RECEIPT_MAX_COLUMNS;
}

/**
 * ESC/POS bytes for a design, made from `layoutReceipt`. The encoder picks the code page by itself (`auto`, generic profile).
 * NOT checked on a printer.
 */
export function receiptToBytes(design: ReceiptDesign): Uint8Array {
  ensureStructuredClone();
  const lines = layoutReceipt(design);
  const encoder = new ReceiptPrinterEncoder({
    language: 'esc-pos',
    columns: encoderColumns(paperColumns(design)),
    newline: '\n',
    codepageCandidates: [...RECEIPT_CODEPAGES],
  });
  encoder.initialize().codepage('auto');
  for (const line of lines) {
    switch (line.kind) {
      case 'text':
        if (line.text === '') {
          encoder.newline();
          break;
        }
        // Reset the style before the line feed: the encoder carries a style over to the next line.
        if (line.bold) encoder.bold(true);
        if (line.size === 2) encoder.size(2, 2);
        encoder.text(line.text);
        if (line.size === 2) encoder.size(1, 1);
        if (line.bold) encoder.bold(false);
        encoder.newline();
        break;
      case 'qr':
        encoder.align(line.align).qrcode(line.data, 2, line.cell, 'm').align('left');
        break;
      case 'barcode':
        encoder.align(line.align).barcode(line.data, 'code128', { height: line.height, text: line.showText }).align('left');
        break;
      case 'cut':
        if (line.fed) {
          encoder.newline(FEED_AFTER_CUT_WITHOUT_CUTTER);
        } else {
          encoder.raw(cutBytes(line.mode));
        }
        break;
    }
  }
  return encoder.encode();
}
