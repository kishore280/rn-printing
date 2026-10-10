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
 *
 * Layout: `zplTypes.ts` (the result types), `zplTokens.ts` (text to commands and
 * the stateless checks), this file (the state of the printer and one method per command).
 */
import {
  BARCODE_1D,
  KNOWN_CI,
  SDK_COMMANDS,
  barcodeDataProblem,
  decodeField,
  decodeGfaData,
  num,
  params,
  rot,
  tokenize,
} from './zplTokens';
import type { Token } from './zplTokens';
import type {
  ZplDocument,
  ZplIssue,
  ZplLabelDoc,
  ZplParseOptions,
  ZplRotation,
  ZplSeverity,
  ZplSymbology,
} from './zplTypes';

export { decodeGfaData } from './zplTokens';
export type * from './zplTypes';

type Params = Array<string | undefined>;

interface PendingField {
  /** What the next ^FD makes. */
  kind: 'text' | 'barcode' | 'qr' | 'code2d' | undefined;
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

/** The printer's state while it reads the text, and one method for each command. */
class ZplReader {
  readonly issues: ZplIssue[] = [];
  readonly labels: ZplLabelDoc[] = [];

  // State that lasts across labels (the printer keeps it until it is changed).
  private pw: number | undefined;
  private ll: number | undefined;
  private utf8 = false;
  private by = { w: 2, r: 3, h: 10 };
  private fw: ZplRotation = 'N';
  private font = { f: 'A', h: 9, w: 5 };

  private label: ZplLabelDoc | undefined;
  private field: PendingField | undefined;
  private lh = { x: 0, y: 0 };

  constructor(private readonly options: ZplParseOptions) {}

  private issue(severity: ZplSeverity, code: string, message: string, t: Token): void {
    this.issues.push({ severity, code, message, command: `${t.prefix}${t.code}`, offset: t.offset });
  }

  private range(t: Token, name: string, v: number | undefined, min: number, max: number): boolean {
    if (v === undefined || (v >= min && v <= max)) return true;
    this.issue('error', 'RANGE', `${name} must be ${min} to ${max}, got ${v}`, t);
    return false;
  }

  private newField(t: Token): PendingField {
    return {
      kind: undefined, x: 0, y: 0, hex: undefined, reverse: false, rotation: this.fw, height: this.by.h,
      showText: true, textAbove: false, model: 2, magnification: 1, font: this.font.f,
      textHeight: this.font.h, textWidth: this.font.w, command: `${t.prefix}${t.code}`, offset: t.offset,
    };
  }

  /** Field state starts when the first command of a field comes. */
  private cur(t: Token): PendingField {
    return (this.field ??= this.newField(t));
  }

  private startLabel(): ZplLabelDoc {
    const label: ZplLabelDoc = { widthDots: this.pw, lengthDots: this.ll, copies: 1, elements: [] };
    this.labels.push(label);
    return label;
  }

  private open(t: Token): ZplLabelDoc {
    if (!this.label) {
      this.issue('warning', 'NO_XA', 'Command outside ^XA ... ^XZ', t);
      this.label = this.startLabel();
    }
    return this.label;
  }

  read(src: string): void {
    for (const t of tokenize(src)) this.command(t);
    if (this.label) {
      this.issues.push({ severity: 'warning', code: 'NO_XZ', message: 'The label has no ^XZ', command: '^XZ', offset: src.length });
    }
    this.checkLabels();
  }

  private command(t: Token): void {
    if (t.prefix === '~') {
      // Host commands. They hold no label content. Only note the unknown ones.
      if (!SDK_COMMANDS.has(t.code)) this.issue('info', 'UNKNOWN_COMMAND', `${t.prefix}${t.code} is not in the SNBC SDK command list`, t);
      return;
    }
    if (!SDK_COMMANDS.has(t.code) && t.code !== 'FX') {
      this.issue('warning', 'UNKNOWN_COMMAND',
        `^${t.code} is not in the SNBC SDK command list. We have no vendor evidence that the printer supports it.`, t);
    }
    const p = params(t.raw);
    switch (t.code) {
      case 'XA': return this.startFormat(t);
      case 'XZ': return this.endFormat(t);
      case 'PW': return this.printWidth(t, p);
      case 'LL': return this.labelLength(t, p);
      case 'LH': this.lh = { x: num(p[0]) ?? 0, y: num(p[1]) ?? 0 }; return;
      case 'PQ': return this.quantity(t, p);
      case 'CI': return this.codePage(t, p);
      case 'FW': this.fw = rot(p[0], 'N'); return;
      case 'CF': return this.defaultFont(p);
      case 'BY': return this.moduleWidth(t, p);
      case 'FO': case 'FT': return this.fieldOrigin(t, p);
      case 'FH': this.cur(t).hex = p[0]?.slice(0, 1) ?? '_'; return;
      case 'FR': this.cur(t).reverse = true; return;
      case 'FN': return this.fieldNumber(t, p);
      case 'A': return this.scalableFont(t, p);
      case 'BQ': return this.qrCode(t, p);
      case 'B7': case 'BX': case 'BD': return this.code2d(t, p);
      case 'BC': case 'B3': case 'BA': case 'BK': case 'B2': case 'BE': case 'B8': case 'BU': case 'B9':
        return this.barcode1d(t, p);
      case 'GB': return this.box(t, p);
      case 'GD': return this.diagonal(t, p);
      case 'GE': return this.ellipse(t, p);
      case 'GF': return this.graphic(t);
      case 'FD': return this.fieldData(t);
      case 'FS': this.field = undefined; return;
      default: return;
    }
  }

  private startFormat(t: Token): void {
    if (this.label) this.issue('warning', 'NESTED_XA', '^XA while the last label has no ^XZ', t);
    this.label = this.startLabel();
    this.field = undefined;
    this.lh = { x: 0, y: 0 };
  }

  private endFormat(t: Token): void {
    if (!this.label) this.issue('warning', 'NO_XA', '^XZ with no ^XA', t);
    if (this.field?.kind !== undefined) this.issue('warning', 'FIELD_OPEN', 'A field has no ^FS before ^XZ', t);
    this.label = undefined;
    this.field = undefined;
  }

  private printWidth(t: Token, p: Params): void {
    const v = num(p[0]);
    if (!this.range(t, 'Print width', v, 2, 32000) || v === undefined) return;
    this.pw = v;
    if (this.label) this.label.widthDots = v;
    const printer = this.options.printerWidthDots;
    if (printer !== undefined && v > printer) {
      this.issue('warning', 'WIDER_THAN_PRINTER', `Print width ${v} is wider than the printer (${printer} dots)`, t);
    }
  }

  private labelLength(t: Token, p: Params): void {
    const v = num(p[0]);
    if (!this.range(t, 'Label length', v, 1, 32000) || v === undefined) return;
    this.ll = v;
    if (this.label) this.label.lengthDots = v;
  }

  private quantity(t: Token, p: Params): void {
    const v = num(p[0]);
    if (this.range(t, 'Quantity', v, 1, 99999999) && v !== undefined) this.open(t).copies = v;
  }

  private codePage(t: Token, p: Params): void {
    const v = num(p[0]);
    if (v === undefined) return;
    if (!KNOWN_CI.has(v)) this.issue('warning', 'CODE_PAGE', `^CI${v} is not in the SNBC SDK code page list`, t);
    this.utf8 = v === 28;
  }

  private defaultFont(p: Params): void {
    const f = this.font;
    this.font = { f: (p[0] ?? f.f).slice(0, 1), h: num(p[1]) ?? f.h, w: num(p[2]) ?? num(p[1]) ?? f.w };
  }

  private moduleWidth(t: Token, p: Params): void {
    const w = num(p[0]);
    const r = num(p[1]);
    const h = num(p[2]);
    this.range(t, 'Module width', w, 1, 10);
    this.range(t, 'Wide bar ratio', r, 2, 3);
    this.range(t, 'Bar height', h, 1, 32000);
    this.by = { w: w ?? this.by.w, r: r ?? this.by.r, h: h ?? this.by.h };
  }

  private fieldOrigin(t: Token, p: Params): void {
    const f = (this.field = this.newField(t));
    const x = num(p[0]) ?? 0;
    const y = num(p[1]) ?? 0;
    this.range(t, 'x', x, 0, 32000);
    this.range(t, 'y', y, 0, 32000);
    f.x = x + this.lh.x;
    f.y = y + this.lh.y;
    if (t.code === 'FT') {
      this.issue('info', 'FT_ORIGIN', '^FT sets the baseline, not the top-left corner. A preview can only approximate it.', t);
    }
  }

  private fieldNumber(t: Token, p: Params): void {
    const n = num(p[0]) ?? 0;
    this.issue('info', 'FIELD_NUMBER', `^FN${n} is for stored formats; the preview shows the field data`, t);
  }

  /** `^A0N,30,30` or `^A@N,30,30,name`: the first parameter is a font and a rotation. */
  private scalableFont(t: Token, p: Params): void {
    const f = this.cur(t);
    const spec = p[0] ?? '';
    f.kind = 'text';
    f.font = spec.slice(0, 1) || this.font.f;
    f.rotation = rot(spec.slice(1, 2), this.fw);
    const h = num(p[1]);
    const w = num(p[2]);
    this.range(t, 'Character height', h, 0, 32000);
    this.range(t, 'Character width', w, 0, 32000);
    // Zebra: a scalable font takes 10 to 32000 (0 means the font's own size).
    for (const [name, v] of [['height', h], ['width', w]] as const) {
      if (v !== undefined && v > 0 && v < 10) {
        this.issue('warning', 'TEXT_SIZE', `Character ${name} ${v} is under 10 dots, the smallest scalable size`, t);
      }
    }
    f.textHeight = h ?? this.font.h;
    f.textWidth = w ?? h ?? this.font.w;
    if (f.font === '@') f.font = p[3] ?? '@';
  }

  private qrCode(t: Token, p: Params): void {
    const f = this.cur(t);
    f.kind = 'qr';
    f.rotation = rot(p[0], this.fw);
    f.model = num(p[1]) === 1 ? 1 : 2;
    const mag = num(p[2]);
    this.range(t, 'QR cell size', mag, 1, 10);
    f.magnification = mag ?? 1;
  }

  private code2d(t: Token, p: Params): void {
    const f = this.cur(t);
    f.kind = 'code2d';
    f.symbology = t.code === 'B7' ? 'pdf417' : t.code === 'BX' ? 'datamatrix' : 'maxicode';
    f.rotation = rot(p[0], this.fw);
    if (t.code === 'B7') {
      this.range(t, 'Security level', num(p[2]), 0, 8);
      this.range(t, 'Rows', num(p[4]), 3, 90);
      this.range(t, 'Columns', num(p[3]), 1, 30);
    }
  }

  private barcode1d(t: Token, p: Params): void {
    const f = this.cur(t);
    f.kind = 'barcode';
    f.symbology = BARCODE_1D[t.code];
    f.rotation = rot(p[0], this.fw);
    // Parameter order differs: ^B3 and ^BK have the check-digit flag before the height.
    const shifted = t.code === 'B3' || t.code === 'BK';
    const h = num(p[shifted ? 2 : 1]);
    this.range(t, 'Bar height', h, 1, 32000);
    f.height = h ?? this.by.h;
    f.showText = (p[shifted ? 3 : 2] ?? 'Y') !== 'N';
    f.textAbove = (p[shifted ? 4 : 3] ?? 'N') === 'Y';
  }

  private box(t: Token, p: Params): void {
    const w = num(p[0]);
    const h = num(p[1]);
    const th = num(p[2]) ?? 1;
    this.range(t, 'Thickness', th, 1, 32000);
    const f = this.cur(t);
    this.open(t).elements.push({
      kind: 'box', x: f.x, y: f.y, width: Math.max(w ?? th, th), height: Math.max(h ?? th, th), thickness: th,
      rounding: num(p[4]) ?? 0, color: p[3] === 'W' ? 'W' : 'B',
    });
  }

  private diagonal(t: Token, p: Params): void {
    const th = num(p[2]) ?? 1;
    this.range(t, 'Thickness', th, 1, 32000);
    const f = this.cur(t);
    this.open(t).elements.push({
      kind: 'diagonal', x: f.x, y: f.y, width: num(p[0]) ?? th, height: num(p[1]) ?? th, thickness: th,
      lean: p[4] === 'L' ? 'L' : 'R',
    });
  }

  private ellipse(t: Token, p: Params): void {
    const th = num(p[2]) ?? 1;
    this.range(t, 'Thickness', th, 1, 32000);
    const f = this.cur(t);
    this.open(t).elements.push({
      kind: 'ellipse', x: f.x, y: f.y, width: num(p[0]) ?? th, height: num(p[1]) ?? th, thickness: th,
    });
  }

  /** `^GFA,total,total,bytesPerRow,data` */
  private graphic(t: Token): void {
    if (!/^A/i.test(t.raw)) {
      this.issue('warning', 'GF_FORMAT', 'Only ^GFA (ASCII hex) is read by the preview', t);
      return;
    }
    const g = t.raw.slice(2).split(',');
    const total = num(g[0]);
    const bpr = num(g[2]);
    const f = this.cur(t);
    if (total !== undefined && total > 99999) {
      this.issue('error', 'GF_LIMIT', `^GFA holds at most 99999 bytes, got ${total}. The printer cuts the image without a message.`, t);
      return;
    }
    if (!bpr || bpr < 1 || !total || total < 1) {
      this.issue('error', 'GF_PARAMS', '^GFA needs the byte counts and the bytes per row', t);
      return;
    }
    const bytes = decodeGfaData(g.slice(3).join(','), bpr);
    if (!bytes) {
      this.issue('error', 'GF_DATA', '^GFA data is not valid ASCII hex or ZPL compression', t);
    } else if (bytes.length !== total) {
      this.issue('error', 'GF_SIZE', `^GFA says ${total} bytes, the data has ${bytes.length}`, t);
    } else {
      this.open(t).elements.push({
        kind: 'image', x: f.x, y: f.y, width: bpr * 8, height: total / bpr, bytesPerRow: bpr, data: bytes,
      });
    }
  }

  /** The field data ends the field's setup: now the element is made. */
  private fieldData(t: Token): void {
    const f = this.cur(t);
    const text = decodeField(t.raw, f.hex, this.utf8);
    const doc = this.open(t);
    if (f.kind === 'barcode' && f.symbology) this.barcodeElement(t, f, text, doc);
    else if (f.kind === 'qr') this.qrElement(t, f, text, doc);
    else if (f.kind === 'code2d' && f.symbology) {
      doc.elements.push({
        kind: 'code2d', symbology: f.symbology as 'pdf417' | 'datamatrix' | 'maxicode', x: f.x, y: f.y,
        rotation: f.rotation, data: text,
      });
    } else this.textElement(t, f, text, doc);
  }

  private barcodeElement(t: Token, f: PendingField, text: string, doc: ZplLabelDoc): void {
    const sym = f.symbology as ZplSymbology;
    const problem = barcodeDataProblem(sym, text);
    if (problem) this.issue('error', 'BARCODE_DATA', problem, t);
    doc.elements.push({
      kind: 'barcode', symbology: sym, x: f.x, y: f.y, rotation: f.rotation, height: f.height,
      moduleWidth: this.by.w, ratio: this.by.r, showText: f.showText, textAbove: f.textAbove, data: text,
    });
  }

  private qrElement(t: Token, f: PendingField, text: string, doc: ZplLabelDoc): void {
    const m = /^([HQML])([AM]),?([\s\S]*)$/.exec(text);
    if (!m) this.issue('error', 'QR_DATA', 'QR data must start with the error correction letter and A or M, for example MA,text', t);
    doc.elements.push({
      kind: 'qr', x: f.x, y: f.y, rotation: f.rotation, model: f.model, magnification: f.magnification,
      errorCorrection: (m?.[1] ?? 'M') as 'L' | 'M' | 'Q' | 'H', data: m?.[3] ?? text,
    });
  }

  private textElement(t: Token, f: PendingField, text: string, doc: ZplLabelDoc): void {
    if (f.kind === undefined) this.issue('info', 'DEFAULT_FONT', 'Text with no ^A uses the default font (^CF)', t);
    doc.elements.push({
      kind: 'text', x: f.x, y: f.y, font: f.font, rotation: f.rotation, height: f.textHeight,
      width: f.textWidth, reverse: f.reverse, text,
    });
    if (!this.utf8 && /[^\x00-\xFF]/.test(text)) {
      this.issue('warning', 'CHARSET', 'The text has characters above Latin-1 and no ^CI28 (UTF-8) before it', t);
    }
  }

  /** Checks that need the whole label. */
  private checkLabels(): void {
    for (const l of this.labels) {
      for (const e of l.elements) {
        if (l.widthDots !== undefined && e.x >= l.widthDots) {
          this.issues.push({ severity: 'warning', code: 'OUTSIDE', message: `An element starts at x=${e.x}, outside the ${l.widthDots}-dot print width`, command: e.kind, offset: 0 });
        }
        if (l.lengthDots !== undefined && e.y >= l.lengthDots) {
          this.issues.push({ severity: 'warning', code: 'OUTSIDE', message: `An element starts at y=${e.y}, outside the ${l.lengthDots}-dot label length`, command: e.kind, offset: 0 });
        }
      }
      if (l.elements.length === 0) {
        this.issues.push({ severity: 'info', code: 'EMPTY', message: 'The label has no printable element', command: '^XA', offset: 0 });
      }
    }
  }
}

/** Parse ZPL II text. It never throws: a bad command becomes an issue. */
export function parseZpl(src: string, options: ZplParseOptions = {}): ZplDocument {
  const reader = new ZplReader(options);
  reader.read(src);
  return { labels: reader.labels, issues: reader.issues };
}

/** Check ZPL text. The same as `parseZpl(text).issues`. */
export function validateZpl(src: string, options: ZplParseOptions = {}): ZplIssue[] {
  return parseZpl(src, options).issues;
}
