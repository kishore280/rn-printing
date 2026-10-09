import { parseExtendedStatus, parseHostIdentification, parseHostStatus } from '../src/status';

const frame = (s: string) => `\x02${s}\x03\r\n`;

describe('parseHostStatus', () => {
  it('reads a good reply', () => {
    const raw =
      frame('030,0,0,1234,000,0,0,0,000,0,0,0') +
      frame('000,0,0,0,0,2,6,0,00000000,1,000') +
      frame('1234,0');
    const s = parseHostStatus(raw);
    expect(s).not.toBeNull();
    expect(s!.ready).toBe(true);
    expect(s!.labelLengthDots).toBe(1234);
  });

  it('reads faults', () => {
    const raw =
      frame('030,1,1,1234,000,0,0,0,000,0,0,0') + frame('000,1,1,0,0,2,6,0,00000000,1,000');
    const s = parseHostStatus(raw)!;
    expect(s.paperOut).toBe(true);
    expect(s.paused).toBe(true);
    expect(s.headOpen).toBe(true);
    expect(s.ribbonOut).toBe(true);
    expect(s.ready).toBe(false);
  });

  it('returns null for other text', () => {
    expect(parseHostStatus('')).toBeNull();
    expect(parseHostStatus('hello')).toBeNull();
  });
});


describe('parseHostIdentification (~HI)', () => {
  it('reads model, firmware, dots per mm and memory', () => {
    const id = parseHostIdentification('\x02ZT230-203dpi,V53.17.7Z,8,8192KB\x03\r\n');
    expect(id).toMatchObject({ model: 'ZT230-203dpi', firmware: 'V53.17.7Z', dotsPerMm: 8, memory: '8192KB' });
  });
  it('reads 300 dpi, and a reply with no number', () => {
    expect(parseHostIdentification('\x02TVSE LP 46 Dlite,FV1.050,12\x03')?.dotsPerMm).toBe(12);
    expect(parseHostIdentification('A,B,x')?.dotsPerMm).toBeNull();
    expect(parseHostIdentification('A,B')).toMatchObject({ model: 'A', firmware: 'B', dotsPerMm: null, memory: '' });
  });
  it('returns null for other text', () => {
    expect(parseHostIdentification('')).toBeNull();
    expect(parseHostIdentification('hello')).toBeNull();
    expect(parseHostIdentification(',,8')).toBeNull();
  });
});

/** Real answers of the owner's TVSE LP 46 Dlite, copied from the app's "What the printer says" page on 2026-10-09. */
describe('real replies of the TVS LP 46 Dlite', () => {
  it('~HS: ready, with the label length', () => {
    const raw = '\x02287,0,0,0178,000,0,0,0,000,0,0,0\x03\r\n\x02001,0,0,0,1,2,3,0,00000000,1,000\x03\r\n\x021234,0\x03\r\n';
    const s = parseHostStatus(raw);
    expect(s?.ready).toBe(true);
    expect(s?.labelLengthDots).toBe(178);
    expect(s?.paperOut).toBe(false);
    expect(s?.headOpen).toBe(false);
  });

  it('~HQES: no errors and no warnings', () => {
    const raw = '\x02\r\n\r\n  PRINTER STATUS                        \r\n   ERRORS:         0 00000000 00000000  \r\n   WARNINGS:       0 00000000 00000000  \r\n\x03';
    const s = parseExtendedStatus(raw);
    expect(s?.hasError).toBe(false);
    expect(s?.hasWarning).toBe(false);
  });

  it('~HI: the third field is 8 dots per mm (the model name also says 200dpi)', () => {
    const id = parseHostIdentification('\x02TVSE LP 46 Dlite-200dpi,V56.17.9Z,8,8172KB\x03\r\n');
    expect(id?.model).toBe('TVSE LP 46 Dlite-200dpi');
    expect(id?.firmware).toBe('V56.17.9Z');
    expect(id?.dotsPerMm).toBe(8);
    expect(id?.memory).toBe('8172KB');
  });
});
