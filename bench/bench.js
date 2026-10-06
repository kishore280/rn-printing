// Compares the TypeScript reference with the C++ core on a full-width label image.
//   npm run bench
// It compiles test/reference with tsc and cpp/ with g++ into a temp folder.
const { execFileSync } = require('child_process');
const { mkdtempSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

const tmp = mkdtempSync(join(tmpdir(), 'bplz-bench-'));
execFileSync('npx', ['tsc', 'test/reference/dither.ts', 'test/reference/zplCompress.ts', 'src/encoding.ts',
  '--outDir', join(tmp, 'js'), '--target', 'ES2019', '--module', 'commonjs', '--skipLibCheck', '--rootDir', '.'], { stdio: 'inherit' });
execFileSync('g++', ['-std=c++17', '-O2', '-o', join(tmp, 'bench'), 'test-native/bench.cpp', 'cpp/bplz_core.cpp']);

const { grayFromRgba, ditherGray } = require(join(tmp, 'js/test/reference/dither.js'));
const { compressZplBitmap } = require(join(tmp, 'js/test/reference/zplCompress.js'));
const { base64Encode } = require(join(tmp, 'js/src/encoding.js'));

const w = 864, h = 1200; // full 108 mm head at 203 dpi, 150 mm tall
const rgba = new Uint8Array(w * h * 4);
let s = 1;
for (let i = 0; i < rgba.length; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; rgba[i] = s >>> 24; }
for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;

function time(name, fn, n = 10) {
  fn();
  const t = process.hrtime.bigint();
  for (let i = 0; i < n; i++) fn();
  console.log(`ts  ${name.padEnd(16)} ${(Number(process.hrtime.bigint() - t) / 1e6 / n).toFixed(2)} ms`);
}
const gray = grayFromRgba(rgba, w, h);
const bits = ditherGray(gray, w, h, { method: 'floyd-steinberg' });
time('gray', () => grayFromRgba(rgba, w, h));
time('floyd', () => ditherGray(gray, w, h, { method: 'floyd-steinberg' }));
time('compress', () => compressZplBitmap(bits.data, bits.bytesPerRow));
time('base64 100KB', () => base64Encode(rgba.subarray(0, 100000)), 100);
console.log('');
console.log(execFileSync(join(tmp, 'bench')).toString());
console.log('Note: this is Node (V8) on this machine. Hermes on a phone is slower for the TS loops, and the C++ numbers will be higher on a phone CPU too.');
