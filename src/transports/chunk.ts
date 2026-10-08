/**
 * Split bytes into pieces of at most `size` bytes. The pieces are views into `data`: nothing is
 * copied, nothing is changed, and joining them in order gives `data` again.
 * An empty input gives no pieces.
 */
export function chunkBytes(data: Uint8Array, size: number): Uint8Array[] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`chunk size must be an integer >= 1, got ${size}`);
  const pieces: Uint8Array[] = [];
  for (let offset = 0; offset < data.length; offset += size) {
    pieces.push(data.subarray(offset, Math.min(offset + size, data.length)));
  }
  return pieces;
}
