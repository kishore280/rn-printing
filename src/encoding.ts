/**
 * Small encoding helpers. They avoid TextEncoder, btoa and Buffer so they work
 * on every Hermes / JSC version that React Native supports.
 */

export function utf8Encode(input: string): Uint8Array {
  // Fast path: plain ASCII is one byte per character, so write straight into the result.
  const n = input.length;
  const ascii = new Uint8Array(n);
  let i = 0;
  for (; i < n; i++) {
    const c = input.charCodeAt(i);
    if (c >= 0x80) break;
    ascii[i] = c;
  }
  if (i === n) return ascii;

  const out: number[] = Array.from(ascii.subarray(0, i));
  for (; i < n; i++) {
    let cp = input.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < n) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f)
      );
    }
  }
  return Uint8Array.from(out);
}

/** Decode bytes as Latin-1. Printer status replies are plain ASCII. */
export function latin1Decode(bytes: ArrayLike<number>): string {
  return asciiToString(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Lookup tables. They are built once, so the hot loops do only array reads and integer maths.
const ENC = new Uint8Array(64);
const DEC = new Int8Array(256).fill(-1);
for (let i = 0; i < 64; i++) {
  const code = B64.charCodeAt(i);
  ENC[i] = code;
  DEC[code] = i;
}

/** Turn ASCII bytes into a string. Works in pieces so a big array does not overflow the call stack. */
export function asciiToString(bytes: Uint8Array): string {
  const PIECE = 0x2000;
  if (bytes.length <= PIECE) return String.fromCharCode.apply(null, bytes as unknown as number[]);
  let s = '';
  for (let i = 0; i < bytes.length; i += PIECE) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + PIECE) as unknown as number[]);
  }
  return s;
}

export function base64Encode(bytes: ArrayLike<number>): string {
  const n = bytes.length;
  const full = n - (n % 3);
  const out = new Uint8Array(Math.ceil(n / 3) * 4);
  let o = 0;
  let i = 0;
  for (; i < full; i += 3) {
    const v = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out[o++] = ENC[(v >> 18) & 63] as number;
    out[o++] = ENC[(v >> 12) & 63] as number;
    out[o++] = ENC[(v >> 6) & 63] as number;
    out[o++] = ENC[v & 63] as number;
  }
  if (n - i === 1) {
    const v = (bytes[i] as number) << 16;
    out[o++] = ENC[(v >> 18) & 63] as number;
    out[o++] = ENC[(v >> 12) & 63] as number;
    out[o++] = 61;
    out[o++] = 61;
  } else if (n - i === 2) {
    const v = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
    out[o++] = ENC[(v >> 18) & 63] as number;
    out[o++] = ENC[(v >> 12) & 63] as number;
    out[o++] = ENC[(v >> 6) & 63] as number;
    out[o++] = 61;
  }
  return asciiToString(out);
}

export function base64Decode(b64: string): Uint8Array {
  const out = new Uint8Array(Math.ceil((b64.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < b64.length; i++) {
    const v = DEC[b64.charCodeAt(i) & 255] as number;
    if (v < 0) continue; // skips '=', white space and other bytes
    buffer = ((buffer << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  return out.slice(0, o);
}
