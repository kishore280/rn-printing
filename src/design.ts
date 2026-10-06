/**
 * Label design model: a list of items with positions in millimetres. A caller draws a whiteboard
 * from it, and `designToZpl` makes the BPLZ text. The user never writes commands.
 *
 * What is exact and what is not:
 * - Boxes, lines, veg symbols and images: the size in dots is exact.
 * - Text, 1D barcodes and QR codes: the printed width is NOT known here. It depends on the
 *   printer font and the data. A preview must read the width from `parseZpl` or from a test print.
 * - Rotation 90 degrees: the origin of a rotated field is NOT checked on a printer.
 * - Nothing in this file is checked on a printer.
 */
import type { Bitmap1bpp } from './bitmap';
import { ZplLabel, escapeFieldData, mmToDots } from './zpl';
import type { Barcode1DType, DotsPerMm } from './zpl';

export interface DesignText {
  kind: 'text';
  xMm: number;
  yMm: number;
  text: string;
  /** Character height in mm. */
  heightMm: number;
  /**
   * Character width in mm. Default: the font's own shape. Font 0 is 15 high by 12 wide (a ratio of 0.8) in
   * Zebra's table of font matrices, so its default width is 0.8 of the height. A different width squeezes or stretches the letters.
   */
  widthMm?: number;
  /** Font letter or digit. Default `0` (scalable). */
  font?: string;
  /** 0 or 90 degrees. */
  rotation?: 0 | 90;
  /** White text on black (^FR). Put it over a filled box. */
  reverse?: boolean;
}

export interface DesignBox {
  kind: 'box';
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  /** Line width in mm. Default 0.25. */
  thicknessMm?: number;
  /** Fill the box with black. */
  filled?: boolean;
}

export interface DesignBarcode {
  kind: 'barcode';
  xMm: number;
  yMm: number;
  type: Barcode1DType;
  data: string;
  heightMm: number;
  /** Narrow bar width in dots, 1 to 10. Default 2. */
  moduleWidth?: number;
  showText?: boolean;
}

export interface DesignQr {
  kind: 'qr';
  xMm: number;
  yMm: number;
  data: string;
  /** Cell size in dots, 1 to 10. Default 4. */
  cell?: number;
  errorCorrection?: 'L' | 'M' | 'Q' | 'H';
}

/** FSSAI veg or non-veg symbol, drawn in black and white. See the notes in docs/FOOD-LABEL.md. */
export interface DesignVeg {
  kind: 'veg';
  xMm: number;
  yMm: number;
  type: 'veg' | 'nonveg';
  /** Side of the outer square in mm. */
  sizeMm: number;
}

export interface DesignImage {
  kind: 'image';
  xMm: number;
  yMm: number;
  bitmap: Bitmap1bpp;
  /** Output of `compressBitmap(bitmap)`. */
  compressed: Uint8Array;
}

export type DesignItem = DesignText | DesignBox | DesignBarcode | DesignQr | DesignVeg | DesignImage;

export interface LabelDesign {
  widthMm: number;
  heightMm: number;
  dotsPerMm?: DotsPerMm;
  copies?: number;
  items: DesignItem[];
}

export interface DesignIssue {
  severity: 'error' | 'warning';
  code: 'OUTSIDE' | 'VEG_SIZE' | 'ROTATION';
  message: string;
  /** Index of the item in `design.items`. */
  item: number;
}

/** Width over height of the scalable font 0: its standard matrix is 15 x 12 (Zebra ZPL II guide, "Font Matrices"). */
export const FONT0_RATIO = 0.8;

/**
 * Minimum size of the veg / non-veg symbol by the area of the principal display panel.
 * Source: FSSAI Labelling and Display Regulations 2020, regulation 5(4)(c). Millimetres.
 */
export function vegMinimums(areaCm2: number): { circleMm: number; triangleMm: number; squareMm: number } {
  if (areaCm2 <= 100) return { circleMm: 3, triangleMm: 2.5, squareMm: 6 };
  if (areaCm2 <= 500) return { circleMm: 4, triangleMm: 3.5, squareMm: 8 };
  if (areaCm2 <= 2500) return { circleMm: 6, triangleMm: 5, squareMm: 12 };
  return { circleMm: 8, triangleMm: 7, squareMm: 16 };
}

/**
 * Draw the veg symbol with printer commands: an outlined square and a filled circle (veg),
 * or a filled triangle (non-veg). The triangle is a stack of thin bars, because ZPL has no
 * filled triangle. All numbers are in dots.
 */
export function vegSymbolZpl(x: number, y: number, side: number, type: 'veg' | 'nonveg'): string {
  const line = Math.max(1, Math.round(side / 12));
  let z = `^FO${x},${y}^GB${side},${side},${line}^FS`;
  const inner = Math.round(side / 2);
  const off = Math.round((side - inner) / 2);
  if (type === 'veg') {
    z += `^FO${x + off},${y + off}^GE${inner},${inner},${inner}^FS`;
    return z;
  }
  const base = inner;
  const height = Math.max(2, Math.round(base * 0.866));
  const top = y + Math.round((side - height) / 2);
  const step = height >= 12 ? 2 : 1;
  for (let r = 0; r < height; r += step) {
    const rows = Math.min(step, height - r);
    const w = Math.max(1, Math.round((base * (r + rows)) / height));
    z += `^FO${x + Math.round((side - w) / 2)},${top + r}^GB${w},${rows},${rows}^FS`;
  }
  return z;
}

/** Find problems that a person can fix. Does not throw. */
export function checkDesign(design: LabelDesign): DesignIssue[] {
  const issues: DesignIssue[] = [];
  const areaCm2 = (design.widthMm * design.heightMm) / 100;
  design.items.forEach((it, item) => {
    if (it.xMm < 0 || it.yMm < 0 || it.xMm >= design.widthMm || it.yMm >= design.heightMm) {
      issues.push({ severity: 'error', code: 'OUTSIDE', message: 'The item starts outside the label', item });
    } else if (it.kind === 'box' && (it.xMm + it.widthMm > design.widthMm || it.yMm + it.heightMm > design.heightMm)) {
      issues.push({ severity: 'warning', code: 'OUTSIDE', message: 'The box goes past the label edge', item });
    } else if (it.kind === 'veg' && (it.xMm + it.sizeMm > design.widthMm || it.yMm + it.sizeMm > design.heightMm)) {
      issues.push({ severity: 'warning', code: 'OUTSIDE', message: 'The symbol goes past the label edge', item });
    }
    if (it.kind === 'veg') {
      const min = vegMinimums(areaCm2).squareMm;
      if (it.sizeMm < min) {
        issues.push({
          severity: 'warning',
          code: 'VEG_SIZE',
          message: `The symbol is smaller than ${min} mm, the FSSAI minimum for this label area`,
          item,
        });
      }
    }
    if (it.kind === 'text' && it.rotation === 90) {
      issues.push({
        severity: 'warning',
        code: 'ROTATION',
        message: 'Rotated text is not checked on the printer. Print a test first.',
        item,
      });
    }
  });
  return issues;
}

/** Build the label. Numbers are checked by `ZplLabel`, which throws `RangeError` for a bad one. */
export function designToLabel(design: LabelDesign): ZplLabel {
  const d: DotsPerMm = design.dotsPerMm ?? 8;
  const dots = (mm: number) => mmToDots(mm, d);
  const label = ZplLabel.fromMm(design.widthMm, design.heightMm, {
    dotsPerMm: d,
    ...(design.copies === undefined ? {} : { copies: design.copies }),
  });
  for (const it of design.items) {
    const x = dots(it.xMm);
    const y = dots(it.yMm);
    switch (it.kind) {
      case 'text': {
        const height = Math.max(1, dots(it.heightMm));
        const width = Math.max(1, it.widthMm === undefined ? Math.round(height * FONT0_RATIO) : dots(it.widthMm));
        const rotation = it.rotation === 90 ? 'R' : 'N';
        if (it.reverse) {
          // ZplLabel.text has no reverse option. Same command text, with ^FR before the data.
          label.raw(
            `^FO${x},${y}^A${(it.font ?? '0').slice(0, 1)}${rotation},${height},${width}^FR^FH_^FD${escapeFieldData(it.text)}^FS`
          );
        } else {
          label.text(x, y, it.text, { font: it.font ?? '0', height, width, rotation });
        }
        break;
      }
      case 'box': {
        const t = Math.max(1, dots(it.thicknessMm ?? 0.25));
        const w = Math.max(1, dots(it.widthMm));
        const h = Math.max(1, dots(it.heightMm));
        // A thickness of at least half the smaller side fills the box.
        label.box(x, y, w, h, it.filled ? Math.max(t, Math.ceil(Math.min(w, h) / 2)) : t);
        break;
      }
      case 'barcode':
        label.barcode(x, y, it.type, it.data, {
          height: Math.max(1, dots(it.heightMm)),
          moduleWidth: it.moduleWidth ?? 2,
          showText: it.showText ?? true,
        });
        break;
      case 'qr':
        label.qr(x, y, it.data, { magnification: it.cell ?? 4, errorCorrection: it.errorCorrection ?? 'M' });
        break;
      case 'veg':
        label.raw(vegSymbolZpl(x, y, Math.max(8, dots(it.sizeMm)), it.type));
        break;
      case 'image':
        label.image(x, y, it.bitmap, it.compressed);
        break;
    }
  }
  return label;
}

/** The BPLZ text for a design. */
export function designToZpl(design: LabelDesign): string {
  return designToLabel(design).toString();
}
