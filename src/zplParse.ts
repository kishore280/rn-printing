/**
 * ZPL II / BPLZ parser and checker (pure TypeScript, no native code).
 *
 * It reads label text and gives two things: a list of drawable elements, and a
 * list of issues. An app can draw a preview from the elements. This is the same
 * text the printer gets, so the preview cannot differ from the print job.
 *
 * What this is NOT:
 * - It is not SNBC's parser. SNBC does not publish a BPLZ command manual.
 *   The command list and the value ranges come from the SNBC SDK V2.4.2.1
 *   C API guide and its native library (see docs/TEARDOWN.md, section 4a),
 *   and from the Zebra ZPL II Programming Guide.
 * - It is NOT checked on a printer. A label with no issue can still print wrong.
 * - It does not draw pixels. The printer's own fonts (A to Z, 0 to 9) have
 *   shapes that we do not have. The caller must approximate them.
 */
import { latin1Decode, utf8Decode } from './encoding';

export type ZplRotation = 'N' | 'R' | 'I' | 'B';

export type ZplSymbology =
  | 'code128'
  | 'code39'
  | 'code93'
  | 'codabar'
  | 'itf'
  | 'ean13'
  | 'ean8'
  | 'upca'
  | 'upce';

export interface ZplText {
  kind: 'text';
  x: number;
  y: number;
  /** Font letter or digit. */
  font: string;
  rotation: ZplRotation;
  /** Character height in dots. */
  height: number;
  /** Character width in dots. */
  width: number;
  /** ^FR: print as white on black. */
  reverse: boolean;
  text: string;
}

export interface ZplBarcode1D {
  kind: 'barcode';
  symbology: ZplSymbology;
  x: number;
  y: number;
  rotation: ZplRotation;
  /** Bar height in dots. */
  height: number;
  /** Narrow bar width in dots (^BY). */
  moduleWidth: number;
  /** Wide to narrow bar ratio (^BY). Only for symbologies that use it. */
  ratio: number;
  /** Print the human-readable line. */
  showText: boolean;
  /** Print the line above the bars. */
  textAbove: boolean;
  data: string;
}

export interface ZplQr {
  kind: 'qr';
  x: number;
  y: number;
  rotation: ZplRotation;
  model: 1 | 2;
  /** Cell size in dots. */
  magnification: number;
  errorCorrection: 'L' | 'M' | 'Q' | 'H';
  data: string;
}

/** A 2D code that we parse but do not draw: the caller can draw a box. */
export interface ZplOtherCode {
  kind: 'code2d';
  symbology: 'pdf417' | 'datamatrix' | 'maxicode';
  x: number;
  y: number;
  rotation: ZplRotation;
  data: string;
}

export interface ZplBox {
  kind: 'box';
  x: number;
  y: number;
  width: number;
  height: number;
  thickness: number;
  /** Corner rounding 0 to 8. */
  rounding: number;
  /** 'B' = black, 'W' = white. */
  color: 'B' | 'W';
}

export interface ZplDiagonal {
  kind: 'diagonal';
  x: number;
  y: number;
  width: number;
  height: number;
  thickness: number;
  /** 'R' = right-leaning (bottom-left to top-right), 'L' = left-leaning. */
  lean: 'R' | 'L';
}

export interface ZplEllipse {
  kind: 'ellipse';
  x: number;
  y: number;
  width: number;
  height: number;
  thickness: number;
}

export interface ZplImage {
  kind: 'image';
  x: number;
  y: number;
  /** Width in dots. */
  width: number;
  /** Height in dots. */
  height: number;
  bytesPerRow: number;
  /** 1 bit per dot, rows of `bytesPerRow` bytes. 1 = black. */
  data: Uint8Array;
}

export type ZplElement =
  | ZplText
  | ZplBarcode1D
  | ZplQr
  | ZplOtherCode
  | ZplBox
  | ZplDiagonal
  | ZplEllipse
  | ZplImage;

export type ZplSeverity = 'error' | 'warning' | 'info';

export interface ZplIssue {
  severity: ZplSeverity;
  /** Stable code, for example `RANGE`, `UNKNOWN_COMMAND`. */
  code: string;
  message: string;
  /** The command, for example `^BY`. */
  command: string;
  /** Position of the command in the source text. */
  offset: number;
}

export interface ZplLabelDoc {
  /** ^PW at the time of this label. Dots. */
  widthDots?: number | undefined;
  /** ^LL at the time of this label. Dots. */
  lengthDots?: number | undefined;
  /** ^PQ quantity. */
  copies: number;
  elements: ZplElement[];
}

export interface ZplDocument {
  labels: ZplLabelDoc[];
  issues: ZplIssue[];
}

export interface ZplParseOptions {
  /** Print width of the printer in dots (864 for a 108 mm, 203 dpi unit). Gives a check, not a default. */
  printerWidthDots?: number;
}

/**
 * Commands that the SNBC SDK V2.4.2.1 native library sends (docs/TEARDOWN.md 4a).
 * A command outside this set is not an error, but we have no vendor evidence for it.
 */
const SDK_COMMANDS: ReadonlySet<string> = new Set([
  'XA', 'XZ', 'FO', 'FD', 'FS', 'FH', 'FR', 'FN', 'A', 'CI', 'BY', 'BC', 'B2', 'B3', 'B7', 'B8', 'B9',
  'BA', 'BD', 'BE', 'BK', 'BQ', 'BU', 'BX', 'GB', 'GD', 'GE', 'GF', 'IM', 'XG', 'XF', 'PW', 'LL', 'LH',
  'LS', 'LT', 'MM', 'MT', 'MN', 'PO', 'PR', 'ST', 'PQ', 'JA', 'JC', 'JR', 'PH', 'PP', 'PS', 'HS', 'HQ',
  'HL', 'HF', 'HR', 'HW', 'ID', 'CN', 'JB', 'JS', 'JU', 'SD', 'TA', 'WC', 'DG', 'DY', 'WN', 'RF', 'RL',
  'RR', 'RS', 'RW', 'WV',
]);

/** Commands we understand fully enough to draw or to check. */
const KNOWN_CI = new Set([0, 13, 27, 28, 29, 30, 31, 33, 34, 35, 36]);

interface Token {
  /** '^' or '~'. */
  prefix: string;
  /** Command code, for example `FO`, `A`. */
  code: string;
  /** Raw parameter text. */
  raw: string;
  offset: number;
}

const BARCODE_1D: Record<string, ZplSymbology> = {
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
function tokenize(src: string): Token[] {
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

function params(raw: string): Array<string | undefined> {
  return raw.split(',').map((p) => (p.length === 0 ? undefined : p));
}

function num(p: string | undefined): number | undefined {
  if (p === undefined || p.trim() === '') return undefined;
  const n = Number(p);
  return Number.isFinite(n) ? n : undefined;
}

function rot(p: string | undefined, dflt: ZplRotation): ZplRotation {
  return p === 'N' || p === 'R' || p === 'I' || p === 'B' ? p : dflt;
}

/** Decode `_XX` hex escapes of ^FH. Runs of escaped bytes become UTF-8 (CI28) or Latin-1 text. */
function decodeField(raw: string, indicator: string | undefined, utf8: boolean): string {
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
function barcodeDataProblem(type: ZplSymbology, data: string): string | undefined {
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

interface PendingField {
  /** What the next ^FD makes. */
  kind:
    | 'text'
    | 'barcode'
    | 'qr'
    | 'code2d'
    | undefined;
  x: number;
  y: number;
  hex: string | undefined;
  reverse: boolean;
  symbology?: ZplSymbology | 'pdf417' | 'datamatrix' | 'maxicode' | undefined;
  rotation: ZplRotation;
  height: number;
  showText: boolean;
  textAbove: boolean;
  model: 1 | 2;
  magnification: number;
  font: string;
  textHeight: number;
  textWidth: number;
  command: string;
  offset: number;
}

/** Parse ZPL II text. It never throws: a bad command becomes an issue. */
export function parseZpl(src: string, options: ZplParseOptions = {}): ZplDocument {
  const issues: ZplIssue[] = [];
  const labels: ZplLabelDoc[] = [];
  const issue = (severity: ZplSeverity, code: string, message: string, t: Token) =>
    issues.push({ severity, code, message, command: `${t.prefix}${t.code}`, offset: t.offset });
  const range = (t: Token, name: string, v: number | undefined, min: number, max: number) => {
    if (v !== undefined && (v < min || v > max)) {
      issue('error', 'RANGE', `${name} must be ${min} to ${max}, got ${v}`, t);
      return false;
    }
    return true;
  };

  // State that lasts across labels (the printer keeps it until it is changed).
  let pw: number | undefined;
  let ll: number | undefined;
  let utf8 = false;
  let by = { w: 2, r: 3, h: 10 };
  let fw: ZplRotation = 'N';
  let font = { f: 'A', h: 9, w: 5 };

  let label: ZplLabelDoc | undefined;
  let field: PendingField | undefined;
  let lh = { x: 0, y: 0 };
  let fn = 0;

  const newField = (t: Token): PendingField => ({
    kind: undefined, x: 0, y: 0, hex: undefined, reverse: false, rotation: fw, height: by.h, showText: true,
    textAbove: false, model: 2, magnification: 1, font: font.f, textHeight: font.h, textWidth: font.w,
    command: `${t.prefix}${t.code}`, offset: t.offset,
  });
  // Field state starts when the first command of a field comes.
  const cur = (t: Token): PendingField => (field ??= newField(t));

  const open = (t: Token): ZplLabelDoc => {
    if (!label) {
      issue('warning', 'NO_XA', 'Command outside ^XA ... ^XZ', t);
      label = { widthDots: pw, lengthDots: ll, copies: 1, elements: [] };
      labels.push(label);
    }
    return label;
  };

  for (const t of tokenize(src)) {
    const p = params(t.raw);
    if (t.prefix === '~') {
      // Host commands. They hold no label content. Only note the unknown ones.
      if (!SDK_COMMANDS.has(t.code)) issue('info', 'UNKNOWN_COMMAND', `${t.prefix}${t.code} is not in the SNBC SDK command list`, t);
      continue;
    }
    if (!SDK_COMMANDS.has(t.code) && t.code !== 'FX') {
      issue('warning', 'UNKNOWN_COMMAND',
        `^${t.code} is not in the SNBC SDK command list. We have no vendor evidence that the printer supports it.`, t);
    }
    switch (t.code) {
      case 'XA':
        if (label) issue('warning', 'NESTED_XA', '^XA while the last label has no ^XZ', t);
        label = { widthDots: pw, lengthDots: ll, copies: 1, elements: [] };
        labels.push(label);
        field = undefined;
        lh = { x: 0, y: 0 };
        break;
      case 'XZ':
        if (!label) issue('warning', 'NO_XA', '^XZ with no ^XA', t);
        if (field?.kind !== undefined) issue('warning', 'FIELD_OPEN', 'A field has no ^FS before ^XZ', t);
        label = undefined;
        field = undefined;
        break;
      case 'PW': {
        const v = num(p[0]);
        if (range(t, 'Print width', v, 2, 32000) && v !== undefined) {
          pw = v;
          if (label) label.widthDots = v;
          if (options.printerWidthDots !== undefined && v > options.printerWidthDots) {
            issue('warning', 'WIDER_THAN_PRINTER', `Print width ${v} is wider than the printer (${options.printerWidthDots} dots)`, t);
          }
        }
        break;
      }
      case 'LL': {
        const v = num(p[0]);
        if (range(t, 'Label length', v, 1, 32000) && v !== undefined) {
          ll = v;
          if (label) label.lengthDots = v;
        }
        break;
      }
      case 'LH':
        lh = { x: num(p[0]) ?? 0, y: num(p[1]) ?? 0 };
        break;
      case 'PQ': {
        const v = num(p[0]);
        if (range(t, 'Quantity', v, 1, 99999999) && v !== undefined) open(t).copies = v;
        break;
      }
      case 'CI': {
        const v = num(p[0]);
        if (v === undefined) break;
        if (!KNOWN_CI.has(v)) issue('warning', 'CODE_PAGE', `^CI${v} is not in the SNBC SDK code page list`, t);
        utf8 = v === 28;
        break;
      }
      case 'FW':
        fw = rot(p[0], 'N');
        break;
      case 'CF':
        font = { f: (p[0] ?? font.f).slice(0, 1), h: num(p[1]) ?? font.h, w: num(p[2]) ?? num(p[1]) ?? font.w };
        break;
      case 'BY': {
        const w = num(p[0]);
        const r = num(p[1]);
        const h = num(p[2]);
        range(t, 'Module width', w, 1, 10);
        range(t, 'Wide bar ratio', r, 2, 3);
        range(t, 'Bar height', h, 1, 32000);
        by = { w: w ?? by.w, r: r ?? by.r, h: h ?? by.h };
        break;
      }
      case 'FO':
      case 'FT': {
        const f = (field = newField(t));
        const x = num(p[0]) ?? 0;
        const y = num(p[1]) ?? 0;
        range(t, 'x', x, 0, 32000);
        range(t, 'y', y, 0, 32000);
        f.x = x + lh.x;
        f.y = y + lh.y;
        if (t.code === 'FT') {
          issue('info', 'FT_ORIGIN', '^FT sets the baseline, not the top-left corner. A preview can only approximate it.', t);
        }
        break;
      }
      case 'FH':
        cur(t).hex = p[0]?.slice(0, 1) ?? '_';
        break;
      case 'FR':
        cur(t).reverse = true;
        break;
      case 'FN':
        fn = num(p[0]) ?? fn;
        issue('info', 'FIELD_NUMBER', `^FN${fn} is for stored formats; the preview shows the field data`, t);
        break;
      case 'A': {
        const f = cur(t);
        const spec = p[0] ?? '';
        // `^A0N,30,30` or `^A@N,30,30,name`: the first parameter is a font and a rotation.
        f.kind = 'text';
        f.font = spec.slice(0, 1) || font.f;
        f.rotation = rot(spec.slice(1, 2), fw);
        const h = num(p[1]);
        const w = num(p[2]);
        range(t, 'Character height', h, 0, 32000);
        range(t, 'Character width', w, 0, 32000);
        // Zebra: a scalable font takes 10 to 32000 (0 means the font's own size).
        for (const [name, v] of [['height', h], ['width', w]] as const) {
          if (v !== undefined && v > 0 && v < 10) issue('warning', 'TEXT_SIZE', `Character ${name} ${v} is under 10 dots, the smallest scalable size`, t);
        }
        f.textHeight = h ?? font.h;
        f.textWidth = w ?? h ?? font.w;
        if (f.font === '@') f.font = p[3] ?? '@';
        break;
      }
      case 'BQ': {
        const f = cur(t);
        f.kind = 'qr';
        f.rotation = rot(p[0], fw);
        f.model = num(p[1]) === 1 ? 1 : 2;
        const mag = num(p[2]);
        range(t, 'QR cell size', mag, 1, 10);
        f.magnification = mag ?? 1;
        break;
      }
      case 'B7':
      case 'BX':
      case 'BD': {
        const f = cur(t);
        f.kind = 'code2d';
        f.symbology = t.code === 'B7' ? 'pdf417' : t.code === 'BX' ? 'datamatrix' : 'maxicode';
        f.rotation = rot(p[0], fw);
        if (t.code === 'B7') {
          range(t, 'Security level', num(p[2]), 0, 8);
          range(t, 'Rows', num(p[4]), 3, 90);
          range(t, 'Columns', num(p[3]), 1, 30);
        }
        break;
      }
      case 'BC': case 'B3': case 'BA': case 'BK': case 'B2': case 'BE': case 'B8': case 'BU': case 'B9': {
        const f = cur(t);
        f.kind = 'barcode';
        f.symbology = BARCODE_1D[t.code];
        f.rotation = rot(p[0], fw);
        // Parameter order differs: ^B3 and ^BK have the check-digit flag before the height.
        const shifted = t.code === 'B3' || t.code === 'BK';
        const h = num(p[shifted ? 2 : 1]);
        range(t, 'Bar height', h, 1, 32000);
        f.height = h ?? by.h;
        f.showText = (p[shifted ? 3 : 2] ?? 'Y') !== 'N';
        f.textAbove = (p[shifted ? 4 : 3] ?? 'N') === 'Y';
        break;
      }
      case 'GB': {
        const w = num(p[0]);
        const h = num(p[1]);
        const th = num(p[2]) ?? 1;
        range(t, 'Thickness', th, 1, 32000);
        const f = cur(t);
        open(t).elements.push({
          kind: 'box', x: f.x, y: f.y, width: Math.max(w ?? th, th), height: Math.max(h ?? th, th), thickness: th,
          rounding: num(p[4]) ?? 0, color: p[3] === 'W' ? 'W' : 'B',
        });
        break;
      }
      case 'GD': {
        const th = num(p[2]) ?? 1;
        range(t, 'Thickness', th, 1, 32000);
        const f = cur(t);
        open(t).elements.push({
          kind: 'diagonal', x: f.x, y: f.y, width: num(p[0]) ?? th, height: num(p[1]) ?? th, thickness: th,
          lean: p[4] === 'L' ? 'L' : 'R',
        });
        break;
      }
      case 'GE': {
        const th = num(p[2]) ?? 1;
        range(t, 'Thickness', th, 1, 32000);
        const f = cur(t);
        open(t).elements.push({
          kind: 'ellipse', x: f.x, y: f.y, width: num(p[0]) ?? th, height: num(p[1]) ?? th, thickness: th,
        });
        break;
      }
      case 'GF': {
        // ^GFA,total,total,bytesPerRow,data
        if (!/^A/i.test(t.raw)) {
          issue('warning', 'GF_FORMAT', 'Only ^GFA (ASCII hex) is read by the preview', t);
          break;
        }
        const g = t.raw.slice(2).split(',');
        const total = num(g[0]);
        const bpr = num(g[2]);
        const data = g.slice(3).join(',');
        const f = cur(t);
        if (total !== undefined && total > 99999) {
          issue('error', 'GF_LIMIT', `^GFA holds at most 99999 bytes, got ${total}. The printer cuts the image without a message.`, t);
          break;
        }
        if (!bpr || bpr < 1 || !total || total < 1) {
          issue('error', 'GF_PARAMS', '^GFA needs the byte counts and the bytes per row', t);
          break;
        }
        const bytes = decodeGfaData(data, bpr);
        if (!bytes) {
          issue('error', 'GF_DATA', '^GFA data is not valid ASCII hex or ZPL compression', t);
        } else if (bytes.length !== total) {
          issue('error', 'GF_SIZE', `^GFA says ${total} bytes, the data has ${bytes.length}`, t);
        } else {
          open(t).elements.push({
            kind: 'image', x: f.x, y: f.y, width: bpr * 8, height: total / bpr, bytesPerRow: bpr, data: bytes,
          });
        }
        break;
      }
      case 'FD': {
        const f = cur(t);
        const text = decodeField(t.raw, f.hex, utf8);
        const doc = open(t);
        if (f.kind === 'barcode' && f.symbology) {
          const sym = f.symbology as ZplSymbology;
          const problem = barcodeDataProblem(sym, text);
          if (problem) issue('error', 'BARCODE_DATA', problem, t);
          doc.elements.push({
            kind: 'barcode', symbology: sym, x: f.x, y: f.y, rotation: f.rotation, height: f.height,
            moduleWidth: by.w, ratio: by.r, showText: f.showText, textAbove: f.textAbove, data: text,
          });
        } else if (f.kind === 'qr') {
          const m = /^([HQML])([AM]),?([\s\S]*)$/.exec(text);
          if (!m) issue('error', 'QR_DATA', 'QR data must start with the error correction letter and A or M, for example MA,text', t);
          doc.elements.push({
            kind: 'qr', x: f.x, y: f.y, rotation: f.rotation, model: f.model, magnification: f.magnification,
            errorCorrection: (m?.[1] ?? 'M') as 'L' | 'M' | 'Q' | 'H', data: m?.[3] ?? text,
          });
        } else if (f.kind === 'code2d' && f.symbology) {
          doc.elements.push({
            kind: 'code2d', symbology: f.symbology as 'pdf417' | 'datamatrix' | 'maxicode', x: f.x, y: f.y,
            rotation: f.rotation, data: text,
          });
        } else {
          if (f.kind === undefined) issue('info', 'DEFAULT_FONT', 'Text with no ^A uses the default font (^CF)', t);
          doc.elements.push({
            kind: 'text', x: f.x, y: f.y, font: f.font, rotation: f.rotation, height: f.textHeight,
            width: f.textWidth, reverse: f.reverse, text,
          });
          if (!utf8 && /[^\x00-\xFF]/.test(text)) {
            issue('warning', 'CHARSET', 'The text has characters above Latin-1 and no ^CI28 (UTF-8) before it', t);
          }
        }
        break;
      }
      case 'FS':
        field = undefined;
        break;
      default:
        break;
    }
  }

  if (label) issues.push({ severity: 'warning', code: 'NO_XZ', message: 'The label has no ^XZ', command: '^XZ', offset: src.length });

  // Checks that need the whole label.
  for (const l of labels) {
    for (const e of l.elements) {
      if (l.widthDots !== undefined && e.x >= l.widthDots) {
        issues.push({ severity: 'warning', code: 'OUTSIDE', message: `An element starts at x=${e.x}, outside the ${l.widthDots}-dot print width`, command: e.kind, offset: 0 });
      }
      if (l.lengthDots !== undefined && e.y >= l.lengthDots) {
        issues.push({ severity: 'warning', code: 'OUTSIDE', message: `An element starts at y=${e.y}, outside the ${l.lengthDots}-dot label length`, command: e.kind, offset: 0 });
      }
    }
    if (l.elements.length === 0) {
      issues.push({ severity: 'info', code: 'EMPTY', message: 'The label has no printable element', command: '^XA', offset: 0 });
    }
  }
  return { labels, issues };
}

/** Check ZPL text. The same as `parseZpl(text).issues`. */
export function validateZpl(src: string, options: ZplParseOptions = {}): ZplIssue[] {
  return parseZpl(src, options).issues;
}
