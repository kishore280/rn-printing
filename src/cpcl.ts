import type { Bitmap1bpp } from './bitmap';
import { utf8Encode } from './encoding';
import { int } from './validate';
import type { Barcode1DType } from './zpl';

export type CpclRotation = 0 | 90 | 180 | 270;

export interface CpclLabelOptions {
  /** Label width in dots (PW). */
  widthDots: number;
  /** Label height in dots. */
  heightDots: number;
  /** Number of copies. Default 1. */
  copies?: number | undefined;
  /** Horizontal offset in dots. Default 0. */
  offset?: number;
  /** Dots per inch. Default 203. */
  dpi?: number;
}

export interface CpclTextOptions {
  /** Font number: '0', '1', '2', '4', '5', '6', '7', '8', '24' or '55'. Default '0'. */
  font?: string;
  /** Font size 0 to 8. Default 0. */
  size?: number;
  rotation?: CpclRotation;
}

export interface CpclBarcodeOptions {
  /** Narrow bar width in dots. Default 2. */
  moduleWidth?: number;
  /** Wide to narrow bar ratio, 0 to 4. Default 1. */
  ratio?: number;
  height?: number;
  /** Print the human-readable text. Default true. */
  showText?: boolean;
  /** Vertical (rotated 90 degrees). Default false. */
  vertical?: boolean;
}

const CPCL_BARCODE: Record<Barcode1DType, string> = {
  code128: '128',
  code39: '39',
  code93: '93',
  codabar: 'CODABAR',
  itf: 'I2OF5',
  ean13: 'EAN13',
  ean8: 'EAN8',
  upca: 'UPCA',
  upce: 'UPCE',
};

function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ');
}

/**
 * Builds one BPLC label (the CPCL-style command set). Origin is the top-left
 * corner. Coordinates are in dots (0 to 9999). Each command ends with CR LF.
 *
 * Command formats follow the public CPCL language and the strings in the SNBC
 * SDK. They are NOT yet checked on a real printer.
 */
export class CpclLabel {
  private readonly parts: Array<string | Uint8Array> = [];
  private readonly opts: Required<CpclLabelOptions>;

  constructor(options: CpclLabelOptions) {
    this.opts = {
      widthDots: int('widthDots', options.widthDots, 1),
      heightDots: int('heightDots', options.heightDots, 1),
      copies: int('copies', options.copies ?? 1, 1),
      offset: int('offset', options.offset ?? 0),
      dpi: int('dpi', options.dpi ?? 203, 1),
    };
  }

  static fromMm(widthMm: number, heightMm: number, options: { dpi?: number; copies?: number } = {}): CpclLabel {
    const dpi = options.dpi ?? 203;
    const perMm = dpi / 25.4;
    return new CpclLabel({
      widthDots: Math.round(widthMm * perMm),
      heightDots: Math.round(heightMm * perMm),
      copies: options.copies,
      dpi,
    });
  }

  text(x: number, y: number, text: string, o: CpclTextOptions = {}): this {
    const cmd = { 0: 'TEXT', 90: 'TEXT90', 180: 'TEXT180', 270: 'TEXT270' }[o.rotation ?? 0];
    this.parts.push(
      `${cmd} ${o.font ?? '0'} ${int('size', o.size ?? 0)} ${int('x', x)} ${int('y', y)} ${oneLine(text)}\r\n`
    );
    return this;
  }

  /** Scalable text. Width and height are font scale factors. */
  scaleText(x: number, y: number, text: string, width: number, height: number, font = '0'): this {
    this.parts.push(
      `SCALE-TEXT ${font} ${int('width', width, 1)} ${int('height', height, 1)} ${int('x', x)} ${int('y', y)} ${oneLine(text)}\r\n`
    );
    return this;
  }

  barcode(x: number, y: number, type: Barcode1DType, data: string, o: CpclBarcodeOptions = {}): this {
    this.parts.push(`BARCODE-TEXT ${o.showText === false ? 'OFF' : '7 0 5'}\r\n`);
    const cmd = o.vertical ? 'VBARCODE' : 'BARCODE';
    this.parts.push(
      `${cmd} ${CPCL_BARCODE[type]} ${int('moduleWidth', o.moduleWidth ?? 2, 1)} ${int('ratio', o.ratio ?? 1)} ` +
        `${int('height', o.height ?? 60, 1)} ${int('x', x)} ${int('y', y)} ${oneLine(data)}\r\n`
    );
    return this;
  }

  barcode128(x: number, y: number, data: string, o: CpclBarcodeOptions = {}): this {
    return this.barcode(x, y, 'code128', data, o);
  }

  qr(x: number, y: number, data: string, o: { model?: 1 | 2; unitWidth?: number; errorCorrection?: 'L' | 'M' | 'Q' | 'H' } = {}): this {
    const unit = int('unitWidth', o.unitWidth ?? 6, 1);
    if (unit > 32) throw new RangeError('unitWidth must be 1 to 32');
    this.parts.push(
      `B QR ${int('x', x)} ${int('y', y)} M ${o.model ?? 2} U ${unit}\r\n` +
        `${o.errorCorrection ?? 'M'}A,${oneLine(data)}\r\nENDQR\r\n`
    );
    return this;
  }

  box(x0: number, y0: number, x1: number, y1: number, thickness = 1): this {
    this.parts.push(
      `BOX ${int('x0', x0)} ${int('y0', y0)} ${int('x1', x1)} ${int('y1', y1)} ${int('thickness', thickness, 1)}\r\n`
    );
    return this;
  }

  line(x0: number, y0: number, x1: number, y1: number, width = 1): this {
    this.parts.push(
      `LINE ${int('x0', x0)} ${int('y0', y0)} ${int('x1', x1)} ${int('y1', y1)} ${int('width', width, 1)}\r\n`
    );
    return this;
  }

  /** Print a 1-bit image with the CG (compressed graphics, raw bytes) command. */
  image(x: number, y: number, bitmap: Bitmap1bpp): this {
    const total = bitmap.bytesPerRow * bitmap.height;
    if (bitmap.data.length < total) throw new RangeError('bitmap data is too short');
    this.parts.push(
      `CG ${bitmap.bytesPerRow} ${bitmap.height} ${int('x', x)} ${int('y', y)} `,
      bitmap.data.subarray(0, total),
      '\r\n'
    );
    return this;
  }

  /** Add any CPCL line yourself. CR LF is added. */
  raw(line: string): this {
    this.parts.push(`${line}\r\n`);
    return this;
  }

  toBytes(): Uint8Array {
    const o = this.opts;
    const chunks: Uint8Array[] = [];
    const push = (p: string | Uint8Array) => chunks.push(typeof p === 'string' ? utf8Encode(p) : p);
    push(`! ${o.offset} ${o.dpi} ${o.dpi} ${o.heightDots} ${o.copies}\r\nPW ${o.widthDots}\r\n`);
    this.parts.forEach(push);
    push('PRINT\r\n');
    let len = 0;
    chunks.forEach((c) => (len += c.length));
    const out = new Uint8Array(len);
    let pos = 0;
    chunks.forEach((c) => {
      out.set(c, pos);
      pos += c.length;
    });
    return out;
  }

  /** The label as text. Image data is shown as raw bytes (latin1), so use toBytes() to print. */
  toString(): string {
    return Array.from(this.toBytes(), (b) => String.fromCharCode(b)).join('');
  }
}

/** CPCL setup commands (sent as `! U1 ...` lines). Send with LabelPrinter.print(string). */
export const cpclSettings = {
  speed(level: number): string {
    return `! U1 SPEED ${int('speed', level)}\r\n`;
  },
  /** Print darkness (TONE). */
  tone(level: number): string {
    return `! U1 TONE ${int('tone', level)}\r\n`;
  },
  senseGap(): string {
    return '! U1 setvar "media.sense_mode" "gap"\r\n';
  },
  senseBar(): string {
    return '! U1 setvar "media.sense_mode" "bar"\r\n';
  },
  calibrate(): string {
    return '! U1 MEDIA-CALIBRATE\r\n';
  },
  reset(): string {
    return '! U1 do "device.reset" ""\r\n';
  },
  printMode(mode: 'tear' | 'peel' | 'rewind' | 'cutter'): string {
    const code = { tear: 'T', peel: 'P', rewind: 'R', cutter: 'C' }[mode];
    return `! U1 PRINT-MODE ${code} N\r\n`;
  },
  configList(): string {
    return '! U1 PRN-CONFIG-LIST\r\n';
  },
};
