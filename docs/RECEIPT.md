# Receipts (ESC/POS)

`src/receipt.ts` turns a filled receipt design into two things:

1. `layoutReceipt(design)`: the lines as they print. Use it for a preview.
2. `receiptToBytes(design)`: ESC/POS bytes for a thermal receipt printer.

Both use the same layout code. The bytes are made from the laid-out lines. So the preview is the print.
`checkReceipt(design)` gives warnings. None of the three throws.

**Not checked on a printer.** Only unit tests ran (`__tests__/receipt.test.ts`). See `docs/REFERENCES.md`.

## Types

```ts
type ReceiptAlign = 'left' | 'center' | 'right';
interface ReceiptPaper { columns: number; dotsWidth: number; cutter: boolean }
type ReceiptBlock =
  | { kind: 'text'; text: string; align?: ReceiptAlign; bold?: boolean; size?: 1 | 2 }
  | { kind: 'row'; left: string; right: string; bold?: boolean; size?: 1 | 2 }
  | { kind: 'rule'; style?: 'single' | 'double' | 'dashed' }
  | { kind: 'feed'; lines: number }
  | { kind: 'table'; columns: { width: number | 'auto'; align: ReceiptAlign }[]; header?: string[]; rows: string[][]; bold?: boolean }
  | { kind: 'qr'; data: string; cell?: number; align?: ReceiptAlign }
  | { kind: 'barcode'; data: string; height?: number; showText?: boolean; align?: ReceiptAlign }
  | { kind: 'cut'; mode?: 'partial' | 'full' };
interface ReceiptDesign { paper: ReceiptPaper; blocks: ReceiptBlock[] }
```

`ReceiptLine` is `text` (already padded and aligned), `qr`, `barcode` or `cut` (`fed: true` when the paper has no cutter).
`ReceiptIssue` has `severity: 'warning'`, a `code` (`unprintable`, `too_wide`, `bad_value`), a `message` and the `blockIndex`
(`-1` for the paper).

## Layout rules

- A line is `paper.columns` wide. At `size: 2` it is `floor(columns / 2)` wide. One code point is one column.
- Word wrap at spaces. A word that is longer than the line is cut hard.
- `text`: split on `\n`, wrap each part, then pad for the alignment. A left line has no padding. No line has trailing spaces.
- `row`: the right text goes to the right edge. If it does not fit, the left text wraps in the width minus the right text minus 1,
  and the right text goes on the last wrapped line. If the right text leaves less than 1 column for the left text, the left text
  prints first and the right text prints on its own line, right-aligned.
- `rule`: `-`, `=` or `- ` repeated to the width.
- `feed`: 1 to 10 empty lines.
- `table`: a fixed column has the width you give. One `auto` column gets the rest (at least 4). One space is between columns.
  A cell may hold `\n`: it is a hard break, and each part wraps inside the column. A row is as tall as its tallest cell.
  The header is a bold row.
- `qr` and `barcode` (Code 128) are one line each. Alignment is done by the encoder.
- `cut`: with a cutter, the bytes are `GS V 66 0` (partial, the default) or `GS V 65 0` (full): Epson's "function B", which first feeds the paper until the last printed line has reached the cutter, then cuts. The cutter sits behind the print head (about 14 mm on an Epson TM-T88), so a plain `GS V 0` / `GS V 1` ("function A", the encoder's own cut) cuts where the cutter is now: on the SPRT SP-POS894UED the QR code of a test receipt came out on the next piece (owner's photos, 2026-10-09). The vendor's Setting Tool for this printer family sends `1D 56 42 00` in its own cut. The printer uses its own distance, so no distance is guessed here; the empty space under the last line comes from the template's `feed` block. Without a cutter, the bytes are 4 empty lines and the layout line has `fed: true`. The preview does not show the feed. NOT checked on the printer after this change.
- A letter that no code page holds is shown as `?` in the layout, as the printer prints it.
- Control characters are removed. A tab is a space.

## Limits

- **Paper is 16 to 48 columns.** The encoder library accepts 32, 35, 42, 44 or 48 columns for ESC/POS. We use the smallest of these
  that is not narrower than the paper. A paper with 80 columns is not supported. `checkReceipt` warns, and 48 is used.
- **`₹` and Tamil print as `?`.** No code page of the encoder has them. `checkReceipt` names the letters. A picture path is a later job.
- The code page is chosen by the encoder (`codepage('auto')`, generic profile). There is no printer model choice.
- A line that fills the whole paper width may be followed by an empty line on some printers (the printer wraps, then it gets a line feed). Not tested.
- The encoder adds a line feed after a QR code, a barcode and a cut. Not tested on a printer.
- `dotsWidth` is checked (192 to 832) but not used in the bytes.

## The encoder and why

Bytes come from `@point-of-sale/receipt-printer-encoder` 4.0.1 (exact version, MIT, pure JavaScript). We do not write ESC/POS commands
ourselves (rule 5 in `AGENTS.md`). `@point-of-sale/codepage-encoder` 3.0.2 is also a dependency, because `isPrintable` and
`checkReceipt` ask it which letters a code page holds. `RECEIPT_CODEPAGES` is the list that goes to both.

The encoder calls `structuredClone` on its normal path. Hermes may not have it. `ensureStructuredClone()` sets a copy function for
plain data when the global is missing. It never replaces an existing one. `receiptToBytes` and `isPrintable` call it.

## Use

```ts
import { checkReceipt, layoutReceipt, receiptToBytes, LabelPrinter } from 'react-native-bplz-label-printer';
// or: from 'react-native-bplz-label-printer/lib/receipt'  (only the receipt module)

const issues = checkReceipt(design);        // show them before print
const lines = layoutReceipt(design);        // draw the preview from these
await printer.printRaw(receiptToBytes(design));
```

`LabelPrinter.printRaw(bytes, options?)` sends bytes through the same queue, link and reconnect rules as `print`.
It does not send a job again after a failed write.

## How to test without a printer

- Unit tests: `npm test` (`__tests__/receipt.test.ts`).
- An ESC/POS emulator over TCP: run one on a computer that listens on port 9100 (for example a virtual ESC/POS printer such as
  `escpos-tools` `escpos-emu` or an "ESC/POS Virtual Printer" app), then send the bytes with `TcpTransport` and `LabelPrinter.printRaw`.
  We did not run an emulator here. Check the QR code, the barcode, bold and size 2.
- A real printer: compare with the preview. Test a full-width line, `é`, and the cut.
