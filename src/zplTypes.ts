/** Types of the ZPL parser: the drawable elements, the issues and the options. */
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

