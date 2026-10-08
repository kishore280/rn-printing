export interface PrinterStatus {
  paperOut: boolean;
  paused: boolean;
  headOpen: boolean;
  ribbonOut: boolean;
  bufferFull: boolean;
  /** Label length in dots, as the printer reports it. */
  labelLengthDots: number;
  /** Number of formats in the receive buffer. */
  formatsInBuffer: number;
  /** The raw reply text. */
  raw: string;
  /** True when there is no fault that stops printing. */
  ready: boolean;
}

/**
 * Parse the reply to the ZPL host status command (~HS).
 * The reply has three lines. Each line starts with STX (0x02) and ends with ETX (0x03).
 * Field positions follow the Zebra ZPL II specification. They are NOT yet checked
 * against a real SNBC BPLZ printer. If the reply has a different shape, this returns null.
 */
export function parseHostStatus(raw: string): PrinterStatus | null {
  const frames = raw.match(/\x02([^\x03]*)\x03/g);
  let lines: string[];
  if (frames && frames.length >= 2) {
    lines = frames.map((f) => f.replace(/[\x02\x03]/g, '').trim());
  } else {
    lines = raw
      .split(/\r?\n/)
      .map((l) => l.replace(/[\x02\x03]/g, '').trim())
      .filter((l) => l.length > 0);
  }
  if (lines.length < 2) return null;

  const a = (lines[0] ?? '').split(',');
  const b = (lines[1] ?? '').split(',');
  if (a.length < 6 || b.length < 4) return null;

  const flag = (v: string | undefined) => (v ?? '').trim() === '1';
  const num = (v: string | undefined) => {
    const n = parseInt((v ?? '').trim(), 10);
    return Number.isNaN(n) ? 0 : n;
  };

  const paperOut = flag(a[1]);
  const paused = flag(a[2]);
  const bufferFull = flag(a[5]);
  const headOpen = flag(b[1]);
  const ribbonOut = flag(b[2]);

  return {
    paperOut,
    paused,
    headOpen,
    ribbonOut,
    bufferFull,
    labelLengthDots: num(a[3]),
    formatsInBuffer: num(a[4]),
    raw,
    ready: !paperOut && !headOpen && !ribbonOut && !paused,
  };
}

export interface ExtendedStatus {
  /** Printer is in error. */
  hasError: boolean;
  hasWarning: boolean;
  /** Error flags as a hex string, as the printer reports them. */
  errorFlags: string;
  warningFlags: string;
  /** Parsed flag bits (bit 0 = least significant). */
  errors: { mediaOut: boolean; ribbonOut: boolean; headOpen: boolean; cutterFault: boolean; headOverTemp: boolean; motorOverTemp: boolean };
  raw: string;
}

/**
 * Parse the reply to ~HQES. Zebra format:
 * `PRINTER STATUS  ERRORS: 1 00000000 00000005  WARNINGS: 1 00000000 00000002`.
 * Bit meaning follows the Zebra spec. NOT yet checked on an SNBC printer.
 */
export function parseExtendedStatus(raw: string): ExtendedStatus | null {
  const m = /ERRORS:\s*(\d)\s+([0-9A-Fa-f]{8})\s+([0-9A-Fa-f]{8})[\s\S]*?WARNINGS:\s*(\d)\s+([0-9A-Fa-f]{8})\s+([0-9A-Fa-f]{8})/.exec(
    raw
  );
  if (!m) return null;
  const errLow = parseInt(m[3] ?? '0', 16);
  return {
    hasError: m[1] === '1',
    hasWarning: m[4] === '1',
    errorFlags: `${m[2]}${m[3]}`,
    warningFlags: `${m[5]}${m[6]}`,
    errors: {
      mediaOut: (errLow & 0x1) !== 0,
      ribbonOut: (errLow & 0x2) !== 0,
      headOpen: (errLow & 0x4) !== 0,
      cutterFault: (errLow & 0x8) !== 0,
      headOverTemp: (errLow & 0x10) !== 0,
      motorOverTemp: (errLow & 0x20) !== 0,
    },
    raw,
  };
}

export interface PrinterIdentity {
  model: string;
  firmware: string;
  /** Dots per millimetre: 8 = 203 dpi, 12 = 300 dpi, 24 = 600 dpi. null when the reply has no number there. */
  dotsPerMm: number | null;
  /** The memory field as the printer writes it ("8192KB"), or an empty string. */
  memory: string;
  raw: string;
}

/**
 * Parse the reply to the ZPL host identification command (~HI): `<STX>model,firmware,dots per mm,memory,options<ETX>`.
 * Source: Zebra ZPL II guide, ~HI. NOT yet checked against a real SNBC BPLZ printer. Returns null when the text has no model and firmware.
 */
export function parseHostIdentification(raw: string): PrinterIdentity | null {
  const text = raw.replace(/[\x02\x03\r\n]+/g, ' ').trim();
  const parts = text.split(',').map((p) => p.trim());
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  const n = Number(parts[2]);
  return {
    model: parts[0],
    firmware: parts[1],
    dotsPerMm: parts[2] !== undefined && parts[2] !== '' && Number.isFinite(n) && n > 0 ? n : null,
    memory: parts[3] ?? '',
    raw,
  };
}
