/** ZPL text to commands: the tokenizer, the parameter readers and the data checks. No state. */
import { latin1Decode, utf8Decode } from './encoding';
import type { ZplRotation, ZplSymbology } from './zplTypes';

/**
 * Commands that the SNBC SDK V2.4.2.1 native library sends (docs/TEARDOWN.md 4a).
 * A command outside this set is not an error, but we have no vendor evidence for it.
 */
export const SDK_COMMANDS: ReadonlySet<string> = new Set([
  'XA', 'XZ', 'FO', 'FD', 'FS', 'FH', 'FR', 'FN', 'A', 'CI', 'BY', 'BC', 'B2', 'B3', 'B7', 'B8', 'B9',
  'BA', 'BD', 'BE', 'BK', 'BQ', 'BU', 'BX', 'GB', 'GD', 'GE', 'GF', 'IM', 'XG', 'XF', 'PW', 'LL', 'LH',
  'LS', 'LT', 'MM', 'MT', 'MN', 'PO', 'PR', 'ST', 'PQ', 'JA', 'JC', 'JR', 'PH', 'PP', 'PS', 'HS', 'HQ',
  'HL', 'HF', 'HR', 'HW', 'ID', 'CN', 'JB', 'JS', 'JU', 'SD', 'TA', 'WC', 'DG', 'DY', 'WN', 'RF', 'RL',
  'RR', 'RS', 'RW', 'WV',
]);

/** Commands we understand fully enough to draw or to check. */
export const KNOWN_CI = new Set([0, 13, 27, 28, 29, 30, 31, 33, 34, 35, 36]);

export interface Token {
  /** '^' or '~'. */
  prefix: string;
  /** Command code, for example `FO`, `A`. */
  code: string;
  /** Raw parameter text. */
  raw: string;
  offset: number;
}

export const BARCODE_1D: Record<string, ZplSymbology> = {
  BC: 'code128',
  B3: 'code39',
  BA: 'code93',
  BK: 'codabar',
  B2: 'itf',
  BE: 'ean13',
  B8: 'ean8',
  BU: 'upca',
  B9: 'upce',
};

/** Split the text into commands. A command starts with ^ or ~ and ends at the next one. */
export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c !== '^' && c !== '~') {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < src.length && src[j] !== '^' && src[j] !== '~') j++;
    const body = src.slice(i + 1, j);
    // ^A is the only one-letter command. All others have two characters.
    const code = body[0] === 'A' && c === '^' ? 'A' : body.slice(0, 2).toUpperCase();
    const raw = body.slice(code.length).replace(/[\r\n]+$/, '');
    out.push({ prefix: c, code, raw, offset: i });
    i = j;
  }
  return out;
}

export function params(raw: string): Array<string | undefined> {
  return raw.split(',').map((p) => (p.length === 0 ? undefined : p));
}

export function num(p: string | undefined): number | undefined {
  if (p === undefined || p.trim() === '') return undefined;
  const n = Number(p);
  return Number.isFinite(n) ? n : undefined;
}

export function rot(p: string | undefined, dflt: ZplRotation): ZplRotation {
  return p === 'N' || p === 'R' || p === 'I' || p === 'B' ? p : dflt;
}

/** Decode `_XX` hex escapes of ^FH. Runs of escaped bytes become UTF-8 (CI28) or Latin-1 text. */
export function decodeField(raw: string, indicator: string | undefined, utf8: boolean): string {
  if (!indicator) return raw;
  let out = '';
  let run: number[] = [];
  const flush = () => {
    if (run.length === 0) return;
    out += utf8 ? utf8Decode(Uint8Array.from(run)) : latin1Decode(run);
    run = [];
  };
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] as string;
    const hex = raw.slice(i + 1, i + 3);
    if (ch === indicator && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      run.push(parseInt(hex, 16));
      i += 2;
    } else {
      flush();
      out += ch;
    }
  }
  flush();
  return out;
}

/**
 * Decode the data of ^GFA: ASCII hex with Zebra's compression.
 * `G`-`Y` = repeat 1 to 19, `g`-`z` = repeat 20 to 400 (they add up),
 * `,` = rest of the row 0, `!` = rest of the row 1, `:` = same row as before.
 * Returns the bytes, or undefined when the data is not valid.
 */
export function decodeGfaData(data: string, bytesPerRow: number): Uint8Array | undefined {
  const rowNibbles = bytesPerRow * 2;
  const rows: string[] = [];
  let row = '';
  let count = 1;
  let counted = false;
  const push = (s: string) => {
    for (const ch of s) {
      row += ch;
      if (row.length === rowNibbles) {
        rows.push(row);
        row = '';
      }
    }
  };
  for (const ch of data.replace(/\s+/g, '')) {
    if (/[0-9A-Fa-f]/.test(ch)) {
      push(ch.repeat(count));
      count = 1;
      counted = false;
    } else if (ch >= 'G' && ch <= 'Y') {
      count = (counted ? count : 0) + (ch.charCodeAt(0) - 70);
      counted = true;
    } else if (ch >= 'g' && ch <= 'z') {
      count = (counted ? count : 0) + (ch.charCodeAt(0) - 102) * 20;
      counted = true;
    } else if (ch === ',' || ch === '!') {
      push((ch === ',' ? '0' : 'F').repeat(rowNibbles - row.length));
      count = 1;
      counted = false;
    } else if (ch === ':') {
      const prev = rows[rows.length - 1];
      if (row.length !== 0 || prev === undefined) return undefined;
      push(prev);
      count = 1;
      counted = false;
    } else {
      return undefined;
    }
  }
  if (row.length !== 0 || counted) return undefined;
  const hex = rows.join('');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

const DIGITS = /^[0-9]*$/;

/** Standard symbology rules for the data. Not checked on the printer. */
export function barcodeDataProblem(type: ZplSymbology, data: string): string | undefined {
  switch (type) {
    case 'code128':
    case 'code93':
      return /^[\x00-\x7F]*$/.test(data) ? undefined : `${type} holds ASCII characters only`;
    case 'code39':
      return /^[A-Z0-9 .$/+%-]*$/.test(data) ? undefined : 'Code 39 holds A-Z, 0-9, space and - . $ / + %';
    case 'codabar':
      return /^[A-D]?[0-9:$/.+-]*[A-D]?$/.test(data) ? undefined : 'Codabar holds 0-9, - $ : / . + and A-D at start and end';
    case 'itf':
      return DIGITS.test(data) ? undefined : 'Interleaved 2 of 5 holds digits only';
    case 'ean13':
      return DIGITS.test(data) && (data.length === 12 || data.length === 13)
        ? undefined
        : 'EAN-13 needs 12 or 13 digits';
    case 'ean8':
      return DIGITS.test(data) && (data.length === 7 || data.length === 8) ? undefined : 'EAN-8 needs 7 or 8 digits';
    case 'upca':
      return DIGITS.test(data) && (data.length === 11 || data.length === 12) ? undefined : 'UPC-A needs 11 or 12 digits';
    case 'upce':
      return DIGITS.test(data) ? undefined : 'UPC-E holds digits only';
  }
}
