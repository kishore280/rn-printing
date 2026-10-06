import { utf8Encode } from './encoding';
import type { Barcode1DType } from './zpl';

/** BPLA rotation. 1 = 0 degrees, 2 = 90, 3 = 180, 4 = 270. */
export type BplaRotation = 1 | 2 | 3 | 4;

export interface BplaTextOptions {
  /** Internal font '0' to '8'. Default '2'. Use smooth() for font 9 sizes. */
  font?: string;
  /** Width magnification 1 to 8. Default 1. */
  widthMult?: number;
  /** Height magnification 1 to 8. Default 1. */
  heightMult?: number;
  rotation?: BplaRotation;
}

export interface BplaBarcodeOptions {
  /** Narrow bar width 1 to 9. Default 2. */
  narrow?: number;
  /** Wide bar width 1 to 9. Default 5. */
  wide?: number;
  height?: number;
  showText?: boolean;
  rotation?: BplaRotation;
}

// Barcode letters follow the Datamax-style language that BPLA matches.
// Uppercase prints the readable text. Lowercase does not.
const BPLA_BARCODE: Partial<Record<Barcode1DType, string>> = {
  code39: 'A',
  upca: 'B',
  upce: 'C',
  itf: 'D',
  code128: 'E',
  ean13: 'F',
  ean8: 'G',
  codabar: 'I',
  code93: 'O',
};

function pad(value: number, width: number, name: string, max = 10 ** width - 1): string {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${name} must be an integer from 0 to ${max}, got ${value}`);
  }
  return String(value).padStart(width, '0');
}

function digit(value: number, name: string, min: number, max: number): string {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}, got ${value}`);
  }
  return String(value);
}

/**
 * Builds one BPLA label.
 *
 * WARNING: BPLA is the least checked part of this package. The record layout
 * comes from format strings in the SNBC SDK and from the public Datamax-style
 * language. It is NOT yet tested on a printer. Try it on a spare label first.
 *
 * The origin is the BOTTOM-LEFT corner. The x and y values (row, column) are
 * in dots, 0 to 9999. A field's position is its bottom-left point before rotation.
 */
export class BplaLabel {
  private readonly parts: string[] = [];
  private copies = 1;

  /** Number of copies (Q). */
  quantity(copies: number): this {
    this.copies = copies;
    pad(copies, 4, 'copies', 9999);
    return this;
  }

  /** Heat / darkness 0 to 30 (H). */
  heat(level: number): this {
    this.parts.push(`H${pad(level, 2, 'heat', 30)}`);
    return this;
  }

  /** Print speed letter, for example 'A' (slow) up. */
  speed(letter: string): this {
    if (!/^[A-Z]$/.test(letter)) throw new RangeError('speed must be one letter A to Z');
    this.parts.push(`P${letter}`);
    return this;
  }

  /** Text with an internal font (0 to 8). `row` is the distance from the bottom edge. */
  text(row: number, col: number, text: string, o: BplaTextOptions = {}): this {
    const font = o.font ?? '2';
    if (!/^[0-8]$/.test(font)) throw new RangeError("font must be '0' to '8'");
    this.parts.push(
      `${o.rotation ?? 1}${font}${digit(o.widthMult ?? 1, 'widthMult', 1, 8)}${digit(o.heightMult ?? 1, 'heightMult', 1, 8)}` +
        `000${pad(row, 4, 'row')}${pad(col, 4, 'col')}${text.replace(/[\r\n]+/g, ' ')}`
    );
    return this;
  }

  /** Smooth (scalable) font 9. `size` is a 3-character code such as 'P06', 'P08' or 'P10'. */
  smooth(row: number, col: number, text: string, size = 'P10', o: BplaTextOptions = {}): this {
    if (!/^[A-Z0-9]{3}$/.test(size)) throw new RangeError('size must be 3 letters or digits');
    this.parts.push(
      `${o.rotation ?? 1}9${digit(o.widthMult ?? 1, 'widthMult', 1, 8)}${digit(o.heightMult ?? 1, 'heightMult', 1, 8)}` +
        `${size}${pad(row, 4, 'row')}${pad(col, 4, 'col')}${text.replace(/[\r\n]+/g, ' ')}`
    );
    return this;
  }

  barcode(row: number, col: number, type: Barcode1DType, data: string, o: BplaBarcodeOptions = {}): this {
    const letter = BPLA_BARCODE[type];
    if (!letter) throw new RangeError(`Barcode type ${type} is not supported by BPLA`);
    const l = o.showText === false ? letter.toLowerCase() : letter;
    this.parts.push(
      `${o.rotation ?? 1}${l}${digit(o.wide ?? 5, 'wide', 1, 9)}${digit(o.narrow ?? 2, 'narrow', 1, 9)}` +
        `${pad(o.height ?? 60, 3, 'height', 999)}${pad(row, 4, 'row')}${pad(col, 4, 'col')}${data.replace(/[\r\n]+/g, ' ')}`
    );
    return this;
  }

  barcode128(row: number, col: number, data: string, o: BplaBarcodeOptions = {}): this {
    return this.barcode(row, col, 'code128', data, o);
  }

  /** Box. width and height are in dots. */
  box(row: number, col: number, width: number, height: number, thickness = 2): this {
    this.parts.push(
      `1X11000${pad(row, 4, 'row')}${pad(col, 4, 'col')}b${pad(width, 4, 'width')}${pad(height, 4, 'height')}` +
        `${pad(thickness, 4, 'thickness')}${pad(thickness, 4, 'thickness')}`
    );
    return this;
  }

  /** Horizontal line (drawn as a flat box). */
  hLine(row: number, col: number, length: number, thickness = 2): this {
    return this.box(row, col, length, thickness, thickness);
  }

  /** Vertical line (drawn as a thin box). */
  vLine(row: number, col: number, length: number, thickness = 2): this {
    return this.box(row, col, thickness, length, thickness);
  }

  /** Add any BPLA record yourself. */
  raw(record: string): this {
    this.parts.push(record);
    return this;
  }

  toString(): string {
    const body = this.parts.concat(`Q${pad(this.copies, 4, 'copies', 9999)}`, 'E');
    return `\x02L\r${body.join('\r')}\r`;
  }

  toBytes(): Uint8Array {
    return utf8Encode(this.toString());
  }
}
