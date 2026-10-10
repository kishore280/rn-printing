/** Text helpers of the receipt module: the code pages, what can print, wrapping and aligning. No layout rules here. */
import CodepageEncoder from '@point-of-sale/codepage-encoder';
import type { Codepage } from '@point-of-sale/codepage-encoder';
import type { ReceiptAlign } from './receiptTypes';

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

/** Every character above ASCII that one of the encoder's code pages holds. */
function codepageCharacters(): Set<number> {
  ensureStructuredClone();
  const set = new Set<number>();
  for (const page of RECEIPT_CODEPAGES) {
    for (const c of CodepageEncoder.getEncoding(page).codepoints) {
      if (typeof c === 'number' && c > 0x7f) set.add(c);
    }
  }
  return set;
}

/** Can this code point print without becoming "?"? ASCII, or a character that one of the encoder's code pages holds. */
export function isPrintable(cp: number): boolean {
  if (cp >= 0x20 && cp <= 0x7e) return true;
  if (cp < 0x20 || cp === 0x7f) return false;
  printableSet ??= codepageCharacters();
  return printableSet.has(cp);
}

// ---------------------------------------------------------------------------------------------------------------------
// small helpers

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

export function inRange(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= min && value <= max;
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

/** One entry for each code point. Line breaks stay as "\n". Tabs become a space. Other control characters go. */
export function normalize(text: string): string {
  return str(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    // eslint-disable-next-line no-control-regex -- control characters must not reach the printer as text
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '');
}

/** The text as the printer prints it: a letter that no code page holds becomes "?". */
export function printableText(text: string): string {
  let out = '';
  for (const ch of Array.from(text)) out += ch === '\n' || isPrintable(ch.codePointAt(0) ?? 0) ? ch : '?';
  return out;
}

export function len(s: string): number {
  return Array.from(s).length;
}

export function cut(s: string, from: number, to?: number): string {
  return Array.from(s).slice(from, to).join('');
}

/** Word wrap at spaces. A word longer than `width` is cut hard. Always returns at least one line. No trailing spaces. */
export function wrap(text: string, width: number): string[] {
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

export function wrapLines(text: string, width: number): string[] {
  return normalize(text)
    .split('\n')
    .flatMap((part) => wrap(part, width));
}

export function align(line: string, width: number, how: ReceiptAlign): string {
  const n = len(line);
  if (how === 'right') return ' '.repeat(Math.max(0, width - n)) + line;
  if (how === 'center') return ' '.repeat(Math.max(0, Math.floor((width - n) / 2))) + line;
  return line;
}

/** Pad a line on the right to `width` (inside a table cell, so the next cell starts at its column). */
export function padCell(line: string, width: number, how: ReceiptAlign): string {
  const n = len(line);
  const total = Math.max(0, width - n);
  if (how === 'right') return ' '.repeat(total) + line;
  if (how === 'center') {
    const left = Math.floor(total / 2);
    return ' '.repeat(left) + line + ' '.repeat(total - left);
  }
  return line + ' '.repeat(total);
}
