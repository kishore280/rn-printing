import type { Bitmap1bpp } from './bitmap';
import { asciiToString, utf8Encode } from './encoding';
import { int } from './validate';

export type Rotation = 'N' | 'R' | 'I' | 'B';

export interface LabelOptions {
  /** Label width in dots. */
  widthDots: number;
  /** Label length in dots. */
  lengthDots: number;
  /** Number of copies. Default 1. */
  copies?: number | undefined;
  /**
   * 'utf8' (default) sends ^CI28 so the printer reads UTF-8 text.
   * 'none' sends no character set command (ASCII only).
   */
  charset?: 'utf8' | 'none' | undefined;
}

export interface TextOptions {
  /** Font letter or digit. Default '0' (scalable font). */
  font?: string;
  /** Character height in dots. Default 30. */
  height?: number;
  /** Character width in dots. Default same as height. */
  width?: number;
  rotation?: Rotation;
}

export interface Barcode128Options {
  /** Bar height in dots. Default 60. */
  height?: number;
  /** Narrow bar width in dots (1 to 10). Default 2. */
  moduleWidth?: number;
  /** Print the human-readable line. Default true. */
  showText?: boolean;
  rotation?: Rotation;
}

export interface QrOptions {
  /** Cell size (1 to 10). Default 4. */
  magnification?: number;
  /** Error correction level. Default 'M'. */
  errorCorrection?: 'L' | 'M' | 'Q' | 'H';
  rotation?: Rotation;
}

export type DotsPerMm = 8 | 12;

/** One-dimensional barcode types for ZplLabel.barcode(). */
export type Barcode1DType =
  | 'code128'
  | 'code39'
  | 'code93'
  | 'codabar'
  | 'itf'
  | 'ean13'
  | 'ean8'
  | 'upca'
  | 'upce';

export interface Barcode1DOptions {
  height?: number;
  moduleWidth?: number;
  showText?: boolean;
  rotation?: Rotation;
}

export interface Pdf417Options {
  /** Row height in dots. Default 10. */
  rowHeight?: number;
  /** Security level 0 to 8. Default 2. */
  security?: number;
  /** Data columns 1 to 30. Default 0 (automatic). */
  columns?: number;
  rotation?: Rotation;
}

export type PrintMode = 'tearOff' | 'peelOff' | 'rewind' | 'cutter' | 'applicator';
export type MediaType = 'label-gap' | 'label-mark' | 'continuous';
export type PrintMethod = 'thermal-transfer' | 'direct-thermal';

/**
 * Escape text for a ^FD field. We send ^FH_ with every field, so `_` is the
 * hex escape character. `^` and `~` would end the field or start a command.
 */
export function escapeFieldData(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/_/g, '_5F')
    .replace(/\^/g, '_5E')
    .replace(/~/g, '_7E');
}

/** Convert millimetres to dots. 203 dpi printers have 8 dots/mm. 300 dpi have 12. */
export function mmToDots(mm: number, dotsPerMm: DotsPerMm = 8): number {
  return Math.round(mm * dotsPerMm);
}

/**
 * Builds one ZPL II label (the BPLZ command set). Coordinates are in dots,
 * with the origin at the top-left corner.
 */
export class ZplLabel {
  private readonly parts: Array<string | Uint8Array> = [];
  private readonly opts: Required<LabelOptions>;

  constructor(options: LabelOptions) {
    this.opts = {
      widthDots: int('widthDots', options.widthDots, 1),
      lengthDots: int('lengthDots', options.lengthDots, 1),
      copies: int('copies', options.copies ?? 1, 1),
      charset: options.charset ?? 'utf8',
    };
  }

  static fromMm(
    widthMm: number,
    lengthMm: number,
    options: { dotsPerMm?: DotsPerMm; copies?: number; charset?: 'utf8' | 'none' } = {}
  ): ZplLabel {
    const d = options.dotsPerMm ?? 8;
    return new ZplLabel({
      widthDots: mmToDots(widthMm, d),
      lengthDots: mmToDots(lengthMm, d),
      copies: options.copies,
      charset: options.charset,
    });
  }

  text(x: number, y: number, text: string, o: TextOptions = {}): this {
    const height = int('height', o.height ?? 30, 1);
    const width = int('width', o.width ?? height, 1);
    const font = (o.font ?? '0').slice(0, 1);
    this.parts.push(
      `^FO${int('x', x)},${int('y', y)}^A${font}${o.rotation ?? 'N'},${height},${width}` +
        `^FH_^FD${escapeFieldData(text)}^FS`
    );
    return this;
  }

  barcode128(x: number, y: number, data: string, o: Barcode128Options = {}): this {
    const mw = int('moduleWidth', o.moduleWidth ?? 2, 1);
    if (mw > 10) throw new RangeError('moduleWidth must be 1 to 10');
    this.parts.push(
      `^FO${int('x', x)},${int('y', y)}^BY${mw}` +
        `^BC${o.rotation ?? 'N'},${int('height', o.height ?? 60, 1)},${o.showText === false ? 'N' : 'Y'},N,N` +
        `^FH_^FD${escapeFieldData(data)}^FS`
    );
    return this;
  }

  qr(x: number, y: number, data: string, o: QrOptions = {}): this {
    const mag = int('magnification', o.magnification ?? 4, 1);
    if (mag > 10) throw new RangeError('magnification must be 1 to 10');
    this.parts.push(
      `^FO${int('x', x)},${int('y', y)}^BQ${o.rotation ?? 'N'},2,${mag}` +
        `^FH_^FD${o.errorCorrection ?? 'M'}A,${escapeFieldData(data)}^FS`
    );
    return this;
  }

  /** Other 1D barcodes. For Code 128 you can also use barcode128(). */
  barcode(x: number, y: number, type: Barcode1DType, data: string, o: Barcode1DOptions = {}): this {
    const mw = int('moduleWidth', o.moduleWidth ?? 2, 1);
    if (mw > 10) throw new RangeError('moduleWidth must be 1 to 10');
    const h = int('height', o.height ?? 60, 1);
    const rot = o.rotation ?? 'N';
    const t = o.showText === false ? 'N' : 'Y';
    const body: Record<Barcode1DType, string> = {
      code128: `^BC${rot},${h},${t},N,N`,
      code39: `^B3${rot},N,${h},${t},N`,
      code93: `^BA${rot},${h},${t},N,N`,
      codabar: `^BK${rot},N,${h},${t},N,A,A`,
      itf: `^B2${rot},${h},${t},N,N`,
      ean13: `^BE${rot},${h},${t},N`,
      ean8: `^B8${rot},${h},${t},N`,
      upca: `^BU${rot},${h},${t},N,Y`,
      upce: `^B9${rot},${h},${t},N,Y`,
    };
    this.parts.push(
      `^FO${int('x', x)},${int('y', y)}^BY${mw}${body[type]}^FH_^FD${escapeFieldData(data)}^FS`
    );
    return this;
  }

  pdf417(x: number, y: number, data: string, o: Pdf417Options = {}): this {
    const cols = int('columns', o.columns ?? 0);
    this.parts.push(
      `^FO${int('x', x)},${int('y', y)}^B7${o.rotation ?? 'N'},${int('rowHeight', o.rowHeight ?? 10, 1)},` +
        `${int('security', o.security ?? 2)},${cols === 0 ? '' : cols},,N` +
        `^FH_^FD${escapeFieldData(data)}^FS`
    );
    return this;
  }

  /**
   * Print a 1-bit image (^GFA). `compressed` is the output of `compressBitmap(bitmap)`:
   * ZPL ASCII-compressed hex. Make it once, then print the label as often as you like.
   */
  image(x: number, y: number, bitmap: Bitmap1bpp, compressed: Uint8Array): this {
    const total = bitmap.bytesPerRow * bitmap.height;
    this.parts.push(
      `^FO${int('x', x)},${int('y', y)}^GFA,${total},${total},${bitmap.bytesPerRow},`,
      compressed,
      '^FS'
    );
    return this;
  }

  /** Print an image saved earlier with zplDownloadImage(). Send only a few bytes. */
  recall(x: number, y: number, name: string, o: { magnifyX?: number; magnifyY?: number } = {}): this {
    this.parts.push(
      `^FO${int('x', x)},${int('y', y)}^XGR:${graphicName(name)}.GRF,${int('magnifyX', o.magnifyX ?? 1, 1)},` +
        `${int('magnifyY', o.magnifyY ?? 1, 1)}^FS`
    );
    return this;
  }

  /** Reverse the label, so black becomes white (^POI turns it by 180 degrees). */
  rotate180(): this {
    this.parts.unshift('^POI');
    return this;
  }

  /** Rectangle outline. thickness is in dots. */
  box(x: number, y: number, width: number, height: number, thickness = 2): this {
    this.parts.push(
      `^FO${int('x', x)},${int('y', y)}^GB${int('width', width, 1)},${int('height', height, 1)},` +
        `${int('thickness', thickness, 1)}^FS`
    );
    return this;
  }

  /** Horizontal line. */
  hLine(x: number, y: number, length: number, thickness = 2): this {
    return this.box(x, y, length, thickness, thickness);
  }

  /** Vertical line. */
  vLine(x: number, y: number, length: number, thickness = 2): this {
    return this.box(x, y, thickness, length, thickness);
  }

  /** Add any ZPL text yourself. It is placed inside the label, before ^PQ. */
  raw(zpl: string): this {
    this.parts.push(zpl);
    return this;
  }

  private head(): string {
    const head = [`^XA`, `^PW${this.opts.widthDots}`, `^LL${this.opts.lengthDots}`];
    if (this.opts.charset === 'utf8') head.push('^CI28');
    return head.join('');
  }

  toString(): string {
    let text = this.head();
    for (const p of this.parts) text += typeof p === 'string' ? p : asciiToString(p);
    return text + `^PQ${this.opts.copies}^XZ`;
  }

  toBytes(): Uint8Array {
    // Strings are encoded once, and image data is copied in as bytes. No big string is built.
    const chunks: Uint8Array[] = [utf8Encode(this.head())];
    let pending = '';
    for (const p of this.parts) {
      if (typeof p === 'string') {
        pending += p;
      } else {
        chunks.push(utf8Encode(pending), p);
        pending = '';
      }
    }
    chunks.push(utf8Encode(pending + `^PQ${this.opts.copies}^XZ`));
    return concatBytes(chunks);
  }
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const c of chunks) length += c.length;
  const out = new Uint8Array(length);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

function graphicName(name: string): string {
  if (!/^[A-Za-z0-9]{1,8}$/.test(name)) throw new RangeError('name must be 1 to 8 letters or digits');
  return name.toUpperCase();
}

/**
 * Save an image in the printer memory (~DG, as R:NAME.GRF). Later labels can use
 * label.recall(x, y, name), so a logo is sent once, not on every label.
 * The image stays until power off (R: is RAM).
 */
export function zplDownloadImage(name: string, bitmap: Bitmap1bpp, compressed: Uint8Array): Uint8Array {
  const total = bitmap.bytesPerRow * bitmap.height;
  const head = utf8Encode(`~DGR:${graphicName(name)}.GRF,${total},${bitmap.bytesPerRow},`);
  return concatBytes([head, compressed]);
}

/** A small label for the first test print. Fits a 50 x 30 mm label at 203 dpi. */
export function testLabel(text = 'Hello'): ZplLabel {
  return ZplLabel.fromMm(50, 30)
    .box(4, 4, 392, 232, 2)
    .text(20, 20, text, { height: 40 })
    .barcode128(20, 80, '12345678', { height: 70 })
    .qr(300, 90, 'test', { magnification: 3 });
}

/**
 * Stand-alone ZPL setup commands. Send them with LabelPrinter.print(string).
 * They change printer settings. Some printers keep them after power off.
 */
export const zplSettings = {
  /** ^MM: tear-off, peel-off, rewind, cutter or applicator. */
  printMode(mode: PrintMode): string {
    const code = { tearOff: 'T', peelOff: 'P', rewind: 'R', cutter: 'C', applicator: 'A' }[mode];
    return `^XA^MM${code}^XZ`;
  },
  /** ^MN: media tracking (gap, mark or continuous) and ^MT: thermal method. */
  media(type: MediaType, method?: PrintMethod): string {
    const mn = { 'label-gap': 'Y', 'label-mark': 'M', continuous: 'N' }[type];
    const mt = method ? `^MT${method === 'thermal-transfer' ? 'T' : 'D'}` : '';
    return `^XA^MN${mn}${mt}^XZ`;
  },
  /** ^PR: print speed in inches per second (1 to 14). */
  speed(ips: number): string {
    return `^XA^PR${int('speed', ips, 1)}^XZ`;
  },
  /** ~SD: darkness 0 to 30. */
  darkness(level: number): string {
    return `~SD${String(int('darkness', level)).padStart(2, '0')}`;
  },
  /** ~JC: measure the media length (calibrate). */
  calibrate(): string {
    return '~JC';
  },
  /** ~PS or ~PP: resume or pause printing. */
  resume(): string {
    return '~PS';
  },
  pause(): string {
    return '~PP';
  },
  /** ~JA: cancel all queued formats. */
  cancelAll(): string {
    return '~JA';
  },
  /** ~HS asks for host status. ~HQES asks for the error and warning flags. */
  hostStatusQuery(): string {
    return '~HS';
  },
  extendedStatusQuery(): string {
    return '~HQES';
  },
};
