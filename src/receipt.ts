/**
 * Thermal receipt printing (ESC/POS). Pure TypeScript. The caller fills a `ReceiptDesign` (text, rows, tables, QR, barcode, cut).
 * `layoutReceipt` gives the lines as they print (for a preview). `receiptToBytes` gives the ESC/POS bytes.
 * Both use the same layout, so the preview is the print.
 *
 * Limits:
 * - Nothing in this file is checked on a printer. Only unit tests ran.
 * - The text goes out as single-byte code pages. Letters in no code page (the rupee sign, Tamil) print as "?".
 *   The layout already shows them as "?". `checkReceipt` names them.
 * - The encoder accepts 32, 35, 42, 44 or 48 columns. So the paper is 16 to 48 columns here.
 * - The encoder library needs `structuredClone`. Hermes may not have it. See `ensureStructuredClone`.
 * See docs/RECEIPT.md.
 */
import ReceiptPrinterEncoder from '@point-of-sale/receipt-printer-encoder';
import { buildReceipt, paperColumns } from './receiptLayout';
import { RECEIPT_CODEPAGES, ensureStructuredClone } from './receiptText';
import { RECEIPT_MAX_COLUMNS } from './receiptTypes';
import type { ReceiptDesign, ReceiptIssue, ReceiptLine } from './receiptTypes';

export { RECEIPT_CODEPAGES, ensureStructuredClone, isPrintable } from './receiptText';
export { RECEIPT_MAX_COLUMNS, RECEIPT_MIN_COLUMNS } from './receiptTypes';
export type * from './receiptTypes';

/** The paper widths the encoder library accepts for ESC/POS. */
const ENCODER_COLUMNS = [32, 35, 42, 44, 48];
const FEED_AFTER_CUT_WITHOUT_CUTTER = 4;

/**
 * The cut. A receipt printer cuts at its cutter, which sits behind the print head (Epson's TM-T88 class: about 14 mm). A plain cut
 * (`GS V 0` / `GS V 1`, "function A") cuts where the cutter is NOW, so the last centimetres of what was printed are still between the head
 * and the cutter and fall on the wrong side: on the owner's SPRT SP-POS894UED the QR code of a test receipt came out on the next piece.
 * `GS V 65 n` / `GS V 66 n` ("function B") first feeds the paper until the last printed line has reached the cutter, then cuts, so the
 * printer's own firmware uses its own distance. Epson ESC/POS reference, `GS V`. The vendor's Setting Tool for this printer family sends
 * `1D 56 42 00` (function B, partial) in its own cut (found in the tool's code, 2026-10-09).
 * 65 is a full cut and 66 a partial cut (one point left uncut); `n` is extra feed after the cutting position, 0 here (the template's own
 * `feed` block gives the empty space under the last line). NOT checked on the printer after this change.
 */
export function cutBytes(mode: 'partial' | 'full'): number[] {
  return [0x1d, 0x56, mode === 'full' ? 65 : 66, 0];
}

/** The lines as they print. One entry for each printed line (text), or each QR code, barcode or cut. */
export function layoutReceipt(design: ReceiptDesign): ReceiptLine[] {
  return buildReceipt(design).lines.map((l) => l.line);
}

/** Warnings about a design. Never throws. A design with warnings still lays out and prints. */
export function checkReceipt(design: ReceiptDesign): ReceiptIssue[] {
  return buildReceipt(design).issues;
}

// ---------------------------------------------------------------------------------------------------------------------
// bytes

/** The smallest paper width that the encoder accepts and that is not narrower than ours. */
function encoderColumns(columns: number): number {
  return ENCODER_COLUMNS.find((c) => c >= columns) ?? RECEIPT_MAX_COLUMNS;
}

/**
 * ESC/POS bytes for a design, made from `layoutReceipt`. The encoder picks the code page by itself (`auto`, generic profile).
 * NOT checked on a printer.
 */
export function receiptToBytes(design: ReceiptDesign): Uint8Array {
  ensureStructuredClone();
  const lines = layoutReceipt(design);
  const encoder = new ReceiptPrinterEncoder({
    language: 'esc-pos',
    columns: encoderColumns(paperColumns(design)),
    newline: '\n',
    codepageCandidates: [...RECEIPT_CODEPAGES],
  });
  encoder.initialize().codepage('auto');
  for (const line of lines) encodeLine(encoder, line);
  return encoder.encode();
}

/** One printed line to encoder calls. */
function encodeLine(encoder: ReceiptPrinterEncoder, line: ReceiptLine): void {
  switch (line.kind) {
    case 'text':
      if (line.text === '') {
        encoder.newline();
        return;
      }
      // Reset the style before the line feed: the encoder carries a style over to the next line.
      if (line.bold) encoder.bold(true);
      if (line.size === 2) encoder.size(2, 2);
      encoder.text(line.text);
      if (line.size === 2) encoder.size(1, 1);
      if (line.bold) encoder.bold(false);
      encoder.newline();
      return;
    case 'qr':
      encoder.align(line.align).qrcode(line.data, 2, line.cell, 'm').align('left');
      return;
    case 'barcode':
      encoder.align(line.align).barcode(line.data, 'code128', { height: line.height, text: line.showText }).align('left');
      return;
    case 'cut':
      if (line.fed) encoder.newline(FEED_AFTER_CUT_WITHOUT_CUTTER);
      else encoder.raw(cutBytes(line.mode));
      return;
  }
}
