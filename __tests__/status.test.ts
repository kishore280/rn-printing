import { parseHostStatus } from '../src/status';

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
