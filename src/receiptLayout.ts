/** Receipt design to lines: one function for each kind of block. The lines are what the preview shows and the bytes print. */
import {
  align,
  clampInt,
  cut,
  inRange,
  isPrintable,
  normalize,
  padCell,
  printableText,
  str,
  wrap,
  wrapLines,
} from './receiptText';
import { RECEIPT_MAX_COLUMNS, RECEIPT_MIN_COLUMNS } from './receiptTypes';
import type { ReceiptAlign, ReceiptBlock, ReceiptDesign, ReceiptIssue, ReceiptLine } from './receiptTypes';

const EMPTY_CELLS_AUTO_MIN = 4;

interface Laid {
  line: ReceiptLine;
  blockIndex: number;
}

export interface Built {
  lines: Laid[];
  issues: ReceiptIssue[];
}

/** What one block needs while it is laid out: the paper, where to put lines, where to put warnings. */
interface Page {
  width: number;
  cutter: boolean;
  push(...lines: ReceiptLine[]): void;
  warn(code: ReceiptIssue['code'], message: string): void;
}

export function paperColumns(design: ReceiptDesign): number {
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
  const rl = Array.from(r).length;
  const ll = Array.from(l).length;
  if (ll + 1 + rl <= width) return [l + ' '.repeat(width - ll - rl) + r];
  // The right text needs at least one column for the left text and one space between them.
  if (rl > width - 2) return [...wrap(l, width), ...wrap(r, width).map((x) => align(x, width, 'right'))];
  const parts = wrap(l, width - rl - 1);
  const last = parts.pop() ?? '';
  return [...parts, last + ' '.repeat(width - Array.from(last).length - rl) + r];
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

type TableBlock = Extract<ReceiptBlock, { kind: 'table' }>;
type TableColumns = TableBlock['columns'];

/** The width of each column. One "auto" column takes what the fixed columns leave. */
function tableWidths(cols: TableColumns, width: number, page: Page): number[] {
  const gaps = cols.length - 1;
  const widths: number[] = [];
  let autoAt = -1;
  let fixed = 0;
  cols.forEach((c, i) => {
    if (c?.width === 'auto' && autoAt === -1) {
      autoAt = i;
      widths.push(0);
      return;
    }
    if (c?.width === 'auto') {
      page.warn('bad_value', 'A table can have one "auto" column only. The others get width 8.');
      widths.push(8);
      fixed += 8;
      return;
    }
    if (!inRange(c?.width, 1, 80)) {
      page.warn('bad_value', `A column width must be a whole number from 1 to 80. Got ${str(c?.width)}.`);
    }
    const w = clampInt(c?.width, 1, 80, 8);
    widths.push(w);
    fixed += w;
  });
  if (autoAt === -1 && fixed + gaps > width) {
    page.warn('too_wide', `The table columns need ${fixed + gaps} characters. The paper has ${width}. The columns are made narrower.`);
  }
  if (autoAt !== -1) {
    const auto = width - fixed - gaps;
    if (auto < EMPTY_CELLS_AUTO_MIN) {
      page.warn('bad_value', `The "auto" column would get ${auto} characters. It needs at least ${EMPTY_CELLS_AUTO_MIN}. Use narrower fixed columns.`);
    }
    widths[autoAt] = Math.max(1, auto);
  }
  shrinkToFit(widths, width - gaps);
  return widths;
}

/** One table row as printed lines: every cell wrapped to its column, the cells side by side. */
function tableRow(cells: unknown[], widths: number[], cols: TableColumns, bold: boolean): ReceiptLine[] {
  const wrapped = widths.map((w, i) => wrapLines(str(cells[i]), w));
  const height = Math.max(1, ...wrapped.map((c) => c.length));
  const out: ReceiptLine[] = [];
  for (let y = 0; y < height; y++) {
    const text = wrapped
      .map((cell, i) => padCell(cell[y] ?? '', widths[i] ?? 1, alignOf(cols[i]?.align, 'left')))
      .join(' ')
      .replace(/ +$/, '');
    out.push(textLine(text, bold, 1));
  }
  return out;
}

function layoutTable(block: TableBlock, page: Page): void {
  const cols = Array.isArray(block.columns) ? block.columns : [];
  if (cols.length === 0) {
    page.warn('bad_value', 'A table needs at least one column.');
    return;
  }
  const widths = tableWidths(cols, page.width, page);
  const lines: ReceiptLine[] = [];
  if (Array.isArray(block.header)) lines.push(...tableRow(block.header, widths, cols, true));
  for (const row of Array.isArray(block.rows) ? block.rows : []) {
    const cells = Array.isArray(row) ? row : [];
    if (cells.length > cols.length) {
      page.warn('bad_value', `A table row has ${cells.length} cells. The table has ${cols.length} columns. The extra cells are not printed.`);
    }
    lines.push(...tableRow(cells, widths, cols, block.bold === true));
  }
  for (const l of lines) if (l.kind === 'text') page.push(textLine(printableText(l.text), l.bold, l.size));
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

function warnUnprintable(block: ReceiptBlock, page: Page): void {
  const bad = new Set<string>();
  for (const t of sourceTexts(block)) {
    for (const ch of Array.from(normalize(t))) {
      if (ch !== '\n' && !isPrintable(ch.codePointAt(0) ?? 0)) bad.add(ch);
    }
  }
  if (bad.size > 0) page.warn('unprintable', `These letters cannot be printed and print as "?": ${Array.from(bad).join(' ')}`);
}

function layoutText(block: Extract<ReceiptBlock, { kind: 'text' }>, page: Page): void {
  const size = sizeOf(block.size);
  const w = size === 2 ? Math.floor(page.width / 2) : page.width;
  const how = alignOf(block.align, 'left');
  for (const t of wrapLines(block.text, w)) page.push(textLine(printableText(align(t, w, how)), block.bold === true, size));
}

function layoutRowBlock(block: Extract<ReceiptBlock, { kind: 'row' }>, page: Page): void {
  const size = sizeOf(block.size);
  const w = size === 2 ? Math.floor(page.width / 2) : page.width;
  for (const t of layoutRow(block.left, block.right, w)) page.push(textLine(printableText(t), block.bold === true, size));
}

function layoutRule(block: Extract<ReceiptBlock, { kind: 'rule' }>, page: Page): void {
  const t = block.style === 'double' ? '=' : block.style === 'dashed' ? '- ' : '-';
  page.push(textLine(cut(t.repeat(page.width), 0, page.width).replace(/ +$/, ''), false, 1));
}

function layoutFeed(block: Extract<ReceiptBlock, { kind: 'feed' }>, page: Page): void {
  if (!inRange(block.lines, 1, 10)) page.warn('bad_value', `Feed lines must be a whole number from 1 to 10. Got ${str(block.lines)}.`);
  const n = clampInt(block.lines, 1, 10, 1);
  for (let i = 0; i < n; i++) page.push(textLine('', false, 1));
}

function layoutQr(block: Extract<ReceiptBlock, { kind: 'qr' }>, page: Page): void {
  if (block.cell !== undefined && !inRange(block.cell, 3, 8)) page.warn('bad_value', `The QR cell size must be a whole number from 3 to 8. Got ${str(block.cell)}.`);
  if (str(block.data) === '') page.warn('bad_value', 'The QR code has no data.');
  page.push({ kind: 'qr', data: str(block.data), cell: clampInt(block.cell, 3, 8, 5), align: alignOf(block.align, 'center') });
}

function layoutBarcode(block: Extract<ReceiptBlock, { kind: 'barcode' }>, page: Page): void {
  if (block.height !== undefined && !inRange(block.height, 40, 120)) page.warn('bad_value', `The barcode height must be a whole number from 40 to 120 dots. Got ${str(block.height)}.`);
  const data = str(block.data);
  // Code 128 holds ASCII 0 to 127 only; printable ASCII is what this module allows.
  if (data === '' || /[^ -~]/.test(data)) page.warn('bad_value', 'A barcode needs text with plain ASCII letters, digits and signs only.');
  page.push({
    kind: 'barcode',
    data: data.replace(/[^ -~]/g, ''),
    height: clampInt(block.height, 40, 120, 64),
    showText: block.showText !== false,
    align: alignOf(block.align, 'center'),
  });
}

function layoutCut(block: Extract<ReceiptBlock, { kind: 'cut' }>, page: Page): void {
  page.push({ kind: 'cut', mode: block.mode === 'full' ? 'full' : 'partial', fed: !page.cutter });
}

function layoutBlock(block: ReceiptBlock, page: Page): void {
  switch (block.kind) {
    case 'text': return layoutText(block, page);
    case 'row': return layoutRowBlock(block, page);
    case 'rule': return layoutRule(block, page);
    case 'feed': return layoutFeed(block, page);
    case 'table': return layoutTable(block, page);
    case 'qr': return layoutQr(block, page);
    case 'barcode': return layoutBarcode(block, page);
    case 'cut': return layoutCut(block, page);
    default:
      page.warn('bad_value', `Unknown block kind "${str((block as { kind?: unknown }).kind)}".`);
  }
}

function paperIssues(design: ReceiptDesign, width: number): ReceiptIssue[] {
  const paper = design?.paper;
  const issues: ReceiptIssue[] = [];
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
  return issues;
}

export function buildReceipt(design: ReceiptDesign): Built {
  const lines: Laid[] = [];
  const width = paperColumns(design);
  const issues = paperIssues(design, width);
  const cutter = design?.paper?.cutter === true;
  const blocks = Array.isArray(design?.blocks) ? design.blocks : [];

  blocks.forEach((raw, blockIndex) => {
    const block = raw as ReceiptBlock | null;
    const page: Page = {
      width,
      cutter,
      push: (...ls) => {
        for (const line of ls) lines.push({ line, blockIndex });
      },
      warn: (code, message) => {
        issues.push({ severity: 'warning', code, message, blockIndex });
      },
    };
    if (block === null || typeof block !== 'object') {
      page.warn('bad_value', 'This block is not an object.');
      return;
    }
    warnUnprintable(block, page);
    layoutBlock(block, page);
  });
  return { lines, issues };
}
