/** Types of the receipt module: the design the caller fills, the lines as they print, the issues. */
export type ReceiptAlign = 'left' | 'center' | 'right';

/** `columns`: characters of the normal font, 16 to 48. `dotsWidth`: print width in dots, 192 to 832. */
export interface ReceiptPaper {
  columns: number;
  dotsWidth: number;
  cutter: boolean;
}

export type ReceiptBlock =
  | { kind: 'text'; text: string; align?: ReceiptAlign; bold?: boolean; size?: 1 | 2 }
  | { kind: 'row'; left: string; right: string; bold?: boolean; size?: 1 | 2 }
  | { kind: 'rule'; style?: 'single' | 'double' | 'dashed' }
  | { kind: 'feed'; lines: number }
  | {
      kind: 'table';
      columns: { width: number | 'auto'; align: ReceiptAlign }[];
      header?: string[];
      rows: string[][];
      bold?: boolean;
    }
  | { kind: 'qr'; data: string; cell?: number; align?: ReceiptAlign }
  | { kind: 'barcode'; data: string; height?: number; showText?: boolean; align?: ReceiptAlign }
  | { kind: 'cut'; mode?: 'partial' | 'full' };

export interface ReceiptDesign {
  paper: ReceiptPaper;
  blocks: ReceiptBlock[];
}

export type ReceiptLine =
  | { kind: 'text'; text: string; bold: boolean; size: 1 | 2 }
  | { kind: 'qr'; data: string; cell: number; align: ReceiptAlign }
  | { kind: 'barcode'; data: string; height: number; showText: boolean; align: ReceiptAlign }
  | { kind: 'cut'; mode: 'partial' | 'full'; fed: boolean };

export interface ReceiptIssue {
  severity: 'warning';
  code: 'unprintable' | 'too_wide' | 'bad_value';
  message: string;
  blockIndex: number;
}

export const RECEIPT_MIN_COLUMNS = 16;
export const RECEIPT_MAX_COLUMNS = 48;
