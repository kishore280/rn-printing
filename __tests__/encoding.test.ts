import { base64Decode, base64Encode, utf8Encode } from '../src/encoding';

describe('encoding', () => {
  it('encodes UTF-8', () => {
    expect(Array.from(utf8Encode('A€😀'))).toEqual([0x41, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80]);
  });

  it('round-trips base64', () => {
    for (let n = 0; n < 6; n++) {
      const data = Uint8Array.from({ length: n }, (_, i) => (i * 53 + 7) & 0xff);
      expect(Array.from(base64Decode(base64Encode(data)))).toEqual(Array.from(data));
    }
  });

  it('matches known base64', () => {
    expect(base64Encode(utf8Encode('Man'))).toBe('TWFu');
    expect(base64Encode(utf8Encode('Ma'))).toBe('TWE=');
  });
});
