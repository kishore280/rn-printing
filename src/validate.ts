/** Check that a number is an integer of at least `min`. Used by every label builder. */
export function int(name: string, value: number, min = 0): number {
  if (!Number.isFinite(value) || Math.round(value) !== value || value < min) {
    throw new RangeError(`${name} must be an integer >= ${min}, got ${value}`);
  }
  return value;
}
