/**
 * Zebra ZPL "ASCII" image compression, used by ^GFA and ~DG.
 *
 * The data is hex text (two characters per byte). A run of the same character
 * is written as a count then the character. Count letters: G..Y = 1..19 and
 * g..z = 20..400 in steps of 20, so a count is the sum of up to two letters.
 * `,` means "the rest of the row is 0", `!` means "the rest of the row is F"
 * and `:` means "this row is the same as the row above".
 *
 * The output is ASCII bytes, written straight into a Uint8Array.
 */
const HEX = new Uint8Array([48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 65, 66, 67, 68, 69, 70]);

function writeRun(out: Uint8Array, o: number, count: number, ch: number): number {
  // Run lengths 1 is just the character itself.
  if (count === 1) {
    out[o++] = ch;
    return o;
  }
  let n = count;
  while (n > 400) {
    out[o++] = 122; // 'z' = 400
    n -= 400;
  }
  if (n >= 20) {
    out[o++] = 103 + (Math.floor(n / 20) - 1); // 'g' = 20 ... 'z' = 400
    n %= 20;
  }
  if (n > 0) out[o++] = 71 + (n - 1); // 'G' = 1 ... 'Y' = 19
  out[o++] = ch;
  return o;
}

/** Compress packed bitmap bytes (1 = black) into ZPL ASCII-compressed hex. */
export function compressZplBitmap(data: Uint8Array, bytesPerRow: number): Uint8Array {
  const rows = Math.floor(data.length / bytesPerRow);
  const hexPerRow = bytesPerRow * 2;
  // Worst case: every hex character stands alone, plus one ':' or ',' per row.
  const out = new Uint8Array(data.length * 2 + rows + 16);
  const hex = new Uint8Array(hexPerRow);
  let o = 0;
  let prevRowStart = -1;

  for (let r = 0; r < rows; r++) {
    const base = r * bytesPerRow;
    // Same as the row above: one ':' replaces the whole row.
    if (prevRowStart >= 0) {
      let same = true;
      const pb = prevRowStart;
      for (let i = 0; i < bytesPerRow; i++) {
        if (data[base + i] !== data[pb + i]) {
          same = false;
          break;
        }
      }
      if (same) {
        out[o++] = 58;
        prevRowStart = base;
        continue;
      }
    }
    prevRowStart = base;

    for (let i = 0; i < bytesPerRow; i++) {
      const b = data[base + i] as number;
      hex[i * 2] = HEX[b >> 4] as number;
      hex[i * 2 + 1] = HEX[b & 15] as number;
    }
    // Find where the rest of the row is all '0' or all 'F'.
    let end = hexPerRow;
    const last = hex[hexPerRow - 1] as number;
    let tail = 0; // 0 none, 1 zeros, 2 ones
    if (last === 48 || last === 70) {
      let k = hexPerRow - 1;
      while (k > 0 && hex[k - 1] === last) k--;
      end = k;
      tail = last === 48 ? 1 : 2;
    }
    let i = 0;
    while (i < end) {
      const ch = hex[i] as number;
      let j = i + 1;
      while (j < end && hex[j] === ch) j++;
      o = writeRun(out, o, j - i, ch);
      i = j;
    }
    if (tail === 1) out[o++] = 44; // ','
    else if (tail === 2) out[o++] = 33; // '!'
  }
  return out.slice(0, o);
}

/** Plain hex (no compression) of packed bitmap bytes, as ASCII bytes. */
export function hexAscii(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length * 2);
  for (let i = 0; i < data.length; i++) {
    const b = data[i] as number;
    out[i * 2] = HEX[b >> 4] as number;
    out[i * 2 + 1] = HEX[b & 15] as number;
  }
  return out;
}

/** Reverse of compressZplBitmap. Used by tests to prove the compression is lossless. */
export function decompressZplBitmap(text: Uint8Array, bytesPerRow: number): Uint8Array {
  const hexPerRow = bytesPerRow * 2;
  const rows: Uint8Array[] = [];
  let row: number[] = [];
  let count = 0;
  const flush = () => {
    rows.push(Uint8Array.from(row));
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as number;
    if (c >= 71 && c <= 89) count += c - 70; // G..Y
    else if (c >= 103 && c <= 122) count += (c - 102) * 20; // g..z
    else if (c === 44 || c === 33) {
      const fill = c === 44 ? 48 : 70;
      while (row.length < hexPerRow) row.push(fill);
      count = 0;
      flush();
    } else if (c === 58) {
      rows.push((rows[rows.length - 1] as Uint8Array).slice());
      count = 0;
    } else {
      const n = count === 0 ? 1 : count;
      for (let k = 0; k < n; k++) row.push(c);
      count = 0;
      if (row.length === hexPerRow) flush();
    }
  }
  const out = new Uint8Array(rows.length * bytesPerRow);
  rows.forEach((r, ri) => {
    for (let i = 0; i < bytesPerRow; i++) {
      const hi = r[i * 2] as number;
      const lo = r[i * 2 + 1] as number;
      const v = (h: number) => (h >= 65 ? h - 55 : h - 48);
      out[ri * bytesPerRow + i] = (v(hi) << 4) | v(lo);
    }
  });
  return out;
}
