/**
 * Differential test: the C++ core (cpp/) must give the same bytes as the TypeScript code.
 * It compiles cpp/ with g++ and is skipped when no g++ is found.
 */
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ditherRgba } from '../test/reference/dither';
import type { DitherMethod } from '../src/bitmap';
import { compressZplBitmap } from '../test/reference/zplCompress';
import { base64Encode } from '../src/encoding';

const haveCompiler = spawnSync('g++', ['--version']).status === 0;
const d = haveCompiler ? describe : describe.skip;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

d('C++ core parity', () => {
  let cli = '';
  beforeAll(() => {
    cli = join(mkdtempSync(join(tmpdir(), 'bplz-')), 'cli');
    execFileSync('g++', ['-std=c++17', '-O2', '-o', cli, 'test-native/cli.cpp', 'cpp/bplz_core.cpp']);
  });
  const run = (args: string[], input: Uint8Array) =>
    new Uint8Array(execFileSync(cli, args, { input: Buffer.from(input), maxBuffer: 1 << 26 }));

  it('dithers the same way', () => {
    const r = rng(11);
    const methods: DitherMethod[] = ['threshold', 'floyd-steinberg', 'atkinson', 'bayer'];
    for (let trial = 0; trial < 40; trial++) {
      const w = 1 + Math.floor(r() * 90);
      const h = 1 + Math.floor(r() * 60);
      const rgba = new Uint8Array(w * h * 4);
      for (let i = 0; i < rgba.length; i++) rgba[i] = trial % 3 === 0 && i % 4 === 3 ? Math.floor(r() * 256) : Math.floor(r() * 256);
      if (trial % 3 !== 0) for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
      const mi = trial % 4;
      const invert = trial % 5 === 0;
      const threshold = 100 + (trial % 50);
      const ts = ditherRgba(rgba, w, h, { method: methods[mi] as DitherMethod, threshold, invert }).data;
      const cpp = run(['dither', String(mi), String(w), String(h), String(threshold), invert ? '1' : '0'], rgba);
      expect(Array.from(cpp)).toEqual(Array.from(ts));
    }
  });

  it('compresses the same way', () => {
    const r = rng(5);
    for (let trial = 0; trial < 60; trial++) {
      const bpr = 1 + Math.floor(r() * 50);
      const rows = 1 + Math.floor(r() * 40);
      const data = new Uint8Array(bpr * rows);
      for (let i = 0; i < data.length; i++) data[i] = trial % 2 ? (r() < 0.7 ? 0 : 255) : Math.floor(r() * 256);
      expect(Array.from(run(['zplc', String(bpr)], data))).toEqual(Array.from(compressZplBitmap(data, bpr)));
    }
  });

  it('encodes base64 the same way', () => {
    const r = rng(9);
    for (let n = 0; n < 60; n++) {
      const data = Uint8Array.from({ length: n * 7 }, () => Math.floor(r() * 256));
      expect(Buffer.from(run(['b64'], data)).toString('latin1')).toBe(base64Encode(data));
    }
  });
});
