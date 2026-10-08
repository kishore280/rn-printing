/**
 * Read-only questions to ask a connected printer, and parsers for what it answers.
 *
 * The idea: a printer can tell a lot once it is connected, and the app should show what THIS printer says, not what we guessed.
 * Each question is a command that only reads: it prints nothing and changes nothing. A printer that does not know a question stays
 * silent, and the app shows "no answer". Every parser keeps unknown lines, so a different printer still shows all it said.
 *
 * Sources: Zebra ZPL II Programming Guide (^HH, ~HI, ~HS, ~HM, ~HQ), and the SNBC SDK V2.4.2.1 native library for the `~WN` reads
 * (see docs/TEARDOWN.md). NOT checked on the SNBC printer: what each question returns there is exactly what the Printer page is for.
 */

export type ProbeGroup = 'standard' | 'snbc';

export interface Probe {
  id: string;
  title: string;
  /** What is sent. Reads only. */
  command: string;
  group: ProbeGroup;
  /** One plain sentence: what the answer tells. */
  tells: string;
}

export const PROBES: readonly Probe[] = [
  { id: 'identity', title: 'Who the printer is', command: '~HI', group: 'standard', tells: 'Model, firmware, resolution and memory.' },
  { id: 'status', title: 'Host status', command: '~HS', group: 'standard', tells: 'Paper out, head open, ribbon out, paused, labels waiting, label length.' },
  { id: 'errors', title: 'Errors and warnings', command: '~HQES', group: 'standard', tells: 'The error and warning flags.' },
  { id: 'config', title: 'Settings it has now', command: '^XA^HH^XZ', group: 'standard', tells: 'Darkness, speed, media type, print method, width, label length and more.' },
  { id: 'memory', title: 'Memory', command: '~HM', group: 'standard', tells: 'Total, maximum and available memory.' },
  { id: 'odometer', title: 'How much it has printed', command: '~HQOD', group: 'standard', tells: 'Print length counters.' },
  { id: 'headlife', title: 'Print head history', command: '~HQPH', group: 'standard', tells: 'Head replacements and life.' },
  { id: 'headtest', title: 'Print head test', command: '~HQJT', group: 'standard', tells: 'A summary of the head test.' },
  { id: 'serial', title: 'Serial number', command: '~HQSN', group: 'standard', tells: "The printer's serial number." },
  { id: 'maintenance', title: 'Maintenance alerts', command: '~HQMA', group: 'standard', tells: 'Which maintenance alerts are on.' },
  { id: 'snbc-version', title: 'SNBC firmware version', command: '~WN01@version~', group: 'snbc', tells: 'SNBC\'s own version answer.' },
  { id: 'snbc-name', title: 'SNBC printer name', command: '~WN00@ini,r,PrinterName~', group: 'snbc', tells: 'The name stored in the printer.' },
  { id: 'snbc-serial', title: 'SNBC serial', command: '~WN00@ini,r,Serial0~', group: 'snbc', tells: 'The serial number stored in the printer.' },
];

export interface ConfigLine {
  /** The value on the left: "+15.0", "5 IPS", "TEAR OFF". */
  value: string;
  /** The words on the right: "DARKNESS", "PRINT SPEED". */
  label: string;
}

/** Remove the control characters that frame a reply, and split it into trimmed, non-empty lines. */
export function replyLines(raw: string): string[] {
  return raw
    .replace(/[\x02\x03]/g, '\n')
    .split(/\r?\n/)
    .map((l) => l.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trimEnd())
    .filter((l) => l.trim().length > 0);
}

/**
 * Read the printer's configuration report (^HH). Each line is a value, a gap of two or more spaces, and a label in capitals:
 * `+15.0     DARKNESS`. A line of another shape is kept with an empty value, so nothing the printer said is lost.
 */
export function parseConfigReport(raw: string): ConfigLine[] {
  const out: ConfigLine[] = [];
  for (const line of replyLines(raw)) {
    // The label is the last run of capital words with single spaces; the value is all that comes before the last gap of two or more spaces.
    const m = /^\s*(.+)\s{2,}([A-Z][A-Z/.\-()]*(?: [A-Z/.\-()]+)*)\s*$/.exec(line);
    if (m && m[1] && m[2]) out.push({ value: m[1].trim(), label: m[2].trim() });
    else out.push({ value: '', label: line.trim() });
  }
  return out;
}

/** The value of the first line whose label contains `text` (capitals). undefined when there is none. */
export function configValue(lines: readonly ConfigLine[], text: string): string | undefined {
  const t = text.toUpperCase();
  return lines.find((l) => l.value !== '' && l.label.toUpperCase().includes(t))?.value;
}

/** What the printer says its settings are, in our own terms. A field is left out when the printer did not say it or said it in a shape we do not know. */
export interface CurrentSettings {
  /** 0 to 30. */
  darkness?: number;
  /** Inches per second. */
  speedIps?: number;
  /** 'tearOff' | 'peelOff' | 'cutter' | 'rewind' | 'applicator' */
  printMode?: string;
  /** 'label-gap' | 'label-mark' | 'continuous' */
  mediaType?: string;
  /** 'thermal-transfer' | 'direct-thermal' */
  method?: string;
  /** Dot rows, -120 to 120. */
  tearOff?: number;
  printWidthDots?: number;
  labelLengthDots?: number;
}

const num = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const m = /[-+]?\d+(\.\d+)?/.exec(v);
  return m ? Number(m[0]) : undefined;
};

/** Map the labels of the configuration report to our settings. Labels follow Zebra's report: DARKNESS, PRINT SPEED, TEAR OFF, PRINT MODE, MEDIA TYPE, PRINT METHOD, PRINT WIDTH, LABEL LENGTH. */
export function settingsFromConfig(lines: readonly ConfigLine[]): CurrentSettings {
  const s: CurrentSettings = {};
  const darkness = num(configValue(lines, 'DARKNESS'));
  if (darkness !== undefined && darkness >= 0 && darkness <= 30) s.darkness = Math.round(darkness);
  const speed = num(configValue(lines, 'PRINT SPEED'));
  if (speed !== undefined && speed > 0) s.speedIps = speed;
  const mode = configValue(lines, 'PRINT MODE')?.toUpperCase();
  if (mode) {
    if (mode.includes('TEAR')) s.printMode = 'tearOff';
    else if (mode.includes('PEEL')) s.printMode = 'peelOff';
    else if (mode.includes('CUT')) s.printMode = 'cutter';
    else if (mode.includes('REWIND')) s.printMode = 'rewind';
    else if (mode.includes('APPLICATOR')) s.printMode = 'applicator';
  }
  const media = configValue(lines, 'MEDIA TYPE')?.toUpperCase();
  if (media) {
    if (media.includes('CONTINUOUS')) s.mediaType = 'continuous';
    else if (media.includes('MARK')) s.mediaType = 'label-mark';
    else if (media.includes('GAP') || media.includes('NOTCH') || media.includes('WEB')) s.mediaType = 'label-gap';
  }
  const method = configValue(lines, 'PRINT METHOD')?.toUpperCase();
  if (method) {
    if (method.includes('TRANS')) s.method = 'thermal-transfer';
    else if (method.includes('DIRECT')) s.method = 'direct-thermal';
  }
  const tear = configValue(lines, 'TEAR OFF');
  const tearNumber = num(tear);
  // The TEAR OFF line has a number (+000); PRINT MODE has the words. Only a line with a number counts.
  const tearLine = lines.find((l) => l.label.toUpperCase() === 'TEAR OFF' && /^[-+]?\d+$/.test(l.value.trim()));
  if (tearLine && tearNumber !== undefined && tearNumber >= -120 && tearNumber <= 120) s.tearOff = Math.round(num(tearLine.value) as number);
  const width = num(configValue(lines, 'PRINT WIDTH'));
  if (width !== undefined && width > 0) s.printWidthDots = Math.round(width);
  const length = num(configValue(lines, 'LABEL LENGTH'));
  if (length !== undefined && length > 0) s.labelLengthDots = Math.round(length);
  return s;
}

export interface MemoryInfo {
  /** Kilobytes. */
  totalKb: number;
  maximumKb: number;
  availableKb: number;
}

/** ~HM: `1024,0780,0780` = total, maximum and available RAM in kilobytes (Zebra ZPL II guide, ~HM). */
export function parseMemory(raw: string): MemoryInfo | null {
  const m = /(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(raw);
  return m ? { totalKb: Number(m[1]), maximumKb: Number(m[2]), availableKb: Number(m[3]) } : null;
}

export interface KeyValue {
  key: string;
  value: string;
}

/**
 * Pull `KEY: value` and `KEY   value` pairs out of any reply (the ~HQ answers are lines like `TOTAL NONRESETTABLE: 1234`), so the page
 * can show a table whatever the printer says. Lines with no pair come back as a key with an empty value.
 */
export function parseKeyValues(raw: string): KeyValue[] {
  return replyLines(raw).map((line) => {
    const colon = /^\s*([^:]{2,60}?)\s*:\s*(.*)$/.exec(line);
    if (colon && colon[1] !== undefined) return { key: colon[1].trim(), value: (colon[2] ?? '').trim() };
    const gap = /^\s*(.+?)\s{2,}(.+?)\s*$/.exec(line);
    if (gap && gap[1] && gap[2]) return { key: gap[1].trim(), value: gap[2].trim() };
    return { key: line.trim(), value: '' };
  });
}
