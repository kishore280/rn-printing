import { PROBES, configValue, parseConfigReport, parseKeyValues, parseMemory, replyLines, settingsFromConfig } from '../src/probe';
import { LabelPrinter } from '../src/printer';
import type { Transport } from '../src/transport';

/** A configuration report in the shape Zebra documents for ^HH, with the settings of the owner's self-test print (docs/REFERENCES.md). */
const REPORT = [
  '\x02',
  '                         TVSE LP 46 Dlite',
  '          +15.0                  DARKNESS',
  '           5 IPS                 PRINT SPEED',
  '          +000                   TEAR OFF',
  '          TEAR OFF               PRINT MODE',
  '          GAP/NOTCH              MEDIA TYPE',
  '          WEB                    SENSOR SELECT',
  '          THERMAL-TRANS.         PRINT METHOD',
  '          864                    PRINT WIDTH',
  '          0561                   LABEL LENGTH',
  '          39.0IN  988MM          MAXIMUM LENGTH',
  '          FV1.050                FIRMWARE',
  '\x03',
].join('\r\n');

describe('probes', () => {
  it('only read: none of the questions prints or changes anything', () => {
    for (const p of PROBES) {
      // Reads are ~H… queries, ^HH, and the SNBC ~WN reads with an `r`.
      expect(p.command).toMatch(/^(~H[A-Z]+|\^XA\^HH\^XZ|~WN01@version~|~WN00@ini,r,[A-Za-z0-9]+~)$/);
      expect(p.command).not.toMatch(/,w,/);
      expect(p.command).not.toMatch(/~WC|~JC|~JR|~JA|~SD|\^MM|\^MN|\^MT|\^PR|\^JU/);
    }
    expect(new Set(PROBES.map((p) => p.id)).size).toBe(PROBES.length);
  });
});

describe('parseConfigReport', () => {
  it('reads value and label pairs and keeps every other line', () => {
    const lines = parseConfigReport(REPORT);
    expect(lines).toContainEqual({ value: '+15.0', label: 'DARKNESS' });
    expect(lines).toContainEqual({ value: '5 IPS', label: 'PRINT SPEED' });
    expect(lines).toContainEqual({ value: '39.0IN  988MM', label: 'MAXIMUM LENGTH' });
    expect(lines).toContainEqual({ value: '', label: 'TVSE LP 46 Dlite' });
    expect(lines.length).toBe(12);
  });
  it('finds a value by part of its label', () => {
    const lines = parseConfigReport(REPORT);
    expect(configValue(lines, 'darkness')).toBe('+15.0');
    expect(configValue(lines, 'firmware')).toBe('FV1.050');
    expect(configValue(lines, 'nothing here')).toBeUndefined();
  });
  it('does not throw on empty or odd text', () => {
    expect(parseConfigReport('')).toEqual([]);
    expect(() => parseConfigReport('\x02\x03\x00\x01')).not.toThrow();
  });
});

describe('settingsFromConfig', () => {
  it('turns the self-test settings into ours', () => {
    expect(settingsFromConfig(parseConfigReport(REPORT))).toEqual({
      darkness: 15,
      speedIps: 5,
      printMode: 'tearOff',
      mediaType: 'label-gap',
      method: 'thermal-transfer',
      tearOff: 0,
      printWidthDots: 864,
      labelLengthDots: 561,
    });
  });
  it('leaves out what the printer did not say or said in another shape', () => {
    expect(settingsFromConfig(parseConfigReport('hello world'))).toEqual({});
    expect(settingsFromConfig([{ value: '99', label: 'DARKNESS' }])).toEqual({});
    expect(settingsFromConfig([{ value: 'DIRECT-THERMAL', label: 'PRINT METHOD' }, { value: 'MARK', label: 'MEDIA TYPE' }, { value: 'CONTINUOUS', label: 'MEDIA TYPE' }])).toEqual({
      method: 'direct-thermal',
      mediaType: 'label-mark',
    });
  });
  it('does not take the PRINT MODE words for the tear-off number', () => {
    expect(settingsFromConfig([{ value: 'TEAR OFF', label: 'PRINT MODE' }])).toEqual({ printMode: 'tearOff' });
    expect(settingsFromConfig([{ value: '-012', label: 'TEAR OFF' }])).toEqual({ tearOff: -12 });
  });
});

describe('parseMemory and parseKeyValues', () => {
  it('reads ~HM', () => {
    expect(parseMemory('\x021024,0780,0780\x03')).toEqual({ totalKb: 1024, maximumKb: 780, availableKb: 780 });
    expect(parseMemory('nothing')).toBeNull();
  });
  it('reads key value lines whatever the shape', () => {
    const kv = parseKeyValues('\x02PRINT METERS\r\n TOTAL NONRESETTABLE:  1234 "\r\nUSER RESETTABLE   56\r\n\x03');
    expect(kv).toEqual([
      { key: 'PRINT METERS', value: '' },
      { key: 'TOTAL NONRESETTABLE', value: '1234 "' },
      { key: 'USER RESETTABLE', value: '56' },
    ]);
    expect(replyLines('\x02a\r\n\r\n b \x03')).toEqual(['a', ' b']);
  });
});

describe('LabelPrinter.ask', () => {
  it('sends the command and returns the reply text, or null for silence', async () => {
    const sent: string[] = [];
    const answers = ['\x021024,0780,0780\x03', ''];
    let reply = '';
    const transport: Transport = {
      connect: async () => undefined,
      disconnect: async () => undefined,
      isConnected: async () => true,
      write: async (b: Uint8Array) => {
        sent.push(String.fromCharCode(...b));
        reply = answers.shift() ?? '';
      },
      read: async () => {
        const r = reply;
        reply = '';
        return Uint8Array.from(Array.from(r).map((c) => c.charCodeAt(0)));
      },
    };
    const printer = new LabelPrinter(transport);
    expect(await printer.ask('~HM')).toBe('\x021024,0780,0780\x03');
    expect(sent).toEqual(['~HM']);
    expect(await printer.ask('~HM')).toBeNull();
  });
});

/**
 * Real answers of the owner's TVSE LP 46 Dlite (firmware V56.17.9Z / FV1.050), copied from the app's "What the printer says" page on 2026-10-09.
 * Only what the parsers read is kept here. They show the shape of each reply; they do not say that the printer's settings are right.
 */
describe('real replies of the TVS LP 46 Dlite', () => {
  const HH = [
    '\x02  15                  DARKNESS          ',
    '  5.1 IPS             PRINT SPEED       ',
    '  +0                  TEAR OFF          ',
    '  TEAR OFF            PRINT MODE        ',
    '  GAP/NOTCH           MEDIA TYPE        ',
    '  WEB                 SENSOR TYPE       ',
    '  MANUAL              SENSOR SELECT     ',
    '  THERMAL-TRANS       PRINT METHOD      ',
    '  856                 PRINT WIDTH       ',
    '  178                 LABEL LENGTH      ',
    '  43  IN  1100MM      MAXIMUM LENGTH    ',
    '  BPLZ                 BPL MODE         ',
    '  864 FULL            RESOLUTION        ',
    '  V56.17.9Z           FIRMWARE          ',
    '  ZAEBYT000895        SERIAL NUMBER     \x03',
  ].join('\r\n');

  it('^HH: the settings come out in our terms', () => {
    expect(settingsFromConfig(parseConfigReport(HH))).toEqual({
      darkness: 15,
      speedIps: 5.1,
      printMode: 'tearOff',
      mediaType: 'label-gap',
      method: 'thermal-transfer',
      tearOff: 0,
      printWidthDots: 856,
      labelLengthDots: 178,
    });
  });

  it('^HH: the command language and the firmware are read as lines', () => {
    const lines = parseConfigReport(HH);
    expect(configValue(lines, 'BPL MODE')).toBe('BPLZ');
    expect(configValue(lines, 'FIRMWARE')).toBe('V56.17.9Z');
  });

  it('~HM: total, maximum and available memory', () => {
    expect(parseMemory('\x028172,8172,8172\x03\r\n')).toEqual({ totalKb: 8172, maximumKb: 8172, availableKb: 8172 });
  });

  it('~HQOD: the print meters are pairs', () => {
    const raw = '\x02\r\n\r\n  PRINT METERS                          \r\n   TOTAL NONRESETTABLE:          154 "  \r\n   USER RESETTABLE CNTR1:        154 "  \x03';
    expect(parseKeyValues(raw)).toContainEqual({ key: 'TOTAL NONRESETTABLE', value: '154 "' });
  });

  it('~WN replies are one line each', () => {
    expect(replyLines('FV1.050.00 Jul 29 2024 09:35:29\r\n')).toEqual(['FV1.050.00 Jul 29 2024 09:35:29']);
    expect(replyLines('TVSE LP 46 Dlite\r\n')).toEqual(['TVSE LP 46 Dlite']);
  });
});
