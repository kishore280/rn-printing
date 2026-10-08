import { chunkBytes } from '../src/transports/chunk';
import { parseExtendedStatus, parseHostIdentification, parseHostStatus } from '../src/status';

/** A small seeded generator (mulberry32), so a failing case can be run again. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('chunkBytes (property test, 2000 random cases)', () => {
  it('keeps every byte in order, never exceeds the limit, and never makes an empty piece', () => {
    const random = rng(20261008);
    for (let i = 0; i < 2000; i++) {
      const length = Math.floor(random() * 3000);
      const size = 1 + Math.floor(random() * 520); // 20 (default MTU) to 517 (largest MTU) is inside this range
      const data = Uint8Array.from({ length }, () => Math.floor(random() * 256));
      const pieces = chunkBytes(data, size);
      // Plain checks inside the loop (jest's expect is slow in 2000 rounds); one expect at the end names the first bad case.
      let at = 0;
      let bad: string | null = pieces.length === Math.ceil(length / size) ? null : `piece count for ${length}/${size}`;
      for (const p of pieces) {
        if (p.length === 0 || p.length > size) bad ??= `piece size ${p.length} for limit ${size}`;
        for (let k = 0; k < p.length; k++) if (p[k] !== data[at + k]) bad ??= `byte ${at + k} differs (${length}/${size})`;
        at += p.length;
      }
      if (at !== length) bad ??= `joined length ${at} is not ${length}`;
      expect(bad).toBeNull();
    }
  });
});

describe('status parsers (fuzz: truncated, garbage and random input never throw)', () => {
  const STX = '\x02';
  const ETX = '\x03';
  const valid = `${STX}030,0,0,0561,000,0,0,0,000,0,0,0${ETX}\r\n${STX}000,0,0,0,0,2,6,0,00000000,1,000${ETX}\r\n${STX}1234,0${ETX}`;
  const parsers = [parseHostStatus, parseExtendedStatus, parseHostIdentification];

  it('survives every truncation of a valid reply', () => {
    for (let n = 0; n <= valid.length; n++) {
      for (const parse of parsers) expect(() => parse(valid.slice(0, n))).not.toThrow();
    }
  });

  it('survives 3000 random strings (control characters, digits, commas, long runs)', () => {
    const random = rng(7);
    const alphabet = `${STX}${ETX}\r\n,0123456789ABCDEFabcdef .-:;/\\"'{}[]é€`;
    for (let i = 0; i < 3000; i++) {
      const length = Math.floor(random() * 400);
      let s = '';
      for (let k = 0; k < length; k++) s += alphabet[Math.floor(random() * alphabet.length)];
      for (const parse of parsers) expect(() => parse(s)).not.toThrow();
    }
  });

  it('gives null for an empty or unrelated reply, never a half-filled object', () => {
    for (const parse of parsers) {
      expect(parse('')).toBeNull();
      expect(parse('hello')).toBeNull();
    }
  });
});
