import { parseHostIdentification, parseHostStatus } from '../src/status';

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
