import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { ERROR_CODES, errorCodeInfo, isKnownErrorCode } from '../src/errorCodes';
import { TransportError } from '../src/errors';
import { isTransient } from '../src/reconnect';

const ROOT = join(__dirname, '..');

function files(dir: string, exts: string[], out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(path);
  }
  return out;
}

/** Every `E_...` word in the TypeScript, Kotlin and Swift sources of the package. */
function codesInSources(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const sources = [
    ...files(join(ROOT, 'src'), ['.ts']),
    ...files(join(ROOT, 'android', 'src'), ['.kt']),
    ...files(join(ROOT, 'ios'), ['.swift']),
  ].filter((f) => !f.endsWith('errorCodes.ts'));
  for (const file of sources) {
    for (const m of readFileSync(file, 'utf8').matchAll(/\bE_[A-Z][A-Z_]*[A-Z]\b/g)) {
      const list = found.get(m[0]) ?? [];
      list.push(file.replace(ROOT, ''));
      found.set(m[0], list);
    }
  }
  return found;
}

describe('error code table', () => {
  it('has every code that Kotlin, Swift and TypeScript use', () => {
    const unknown = [...codesInSources()].filter(([code]) => !isKnownErrorCode(code)).map(([code, where]) => `${code} in ${where[0]}`);
    expect(unknown).toEqual([]);
  });

  it('has no code that nothing uses', () => {
    const used = codesInSources();
    expect(Object.keys(ERROR_CODES).filter((c) => !used.has(c))).toEqual([]);
  });

  it('never retries a code that the user must fix', () => {
    for (const [code, info] of Object.entries(ERROR_CODES)) {
      if (info.userFix) expect([code, info.transient]).toEqual([code, false]);
    }
  });

  it('retries exactly the transient codes', () => {
    for (const [code, info] of Object.entries(ERROR_CODES)) {
      expect([code, isTransient(new TransportError('x', code))]).toEqual([code, info.transient]);
    }
    expect(isTransient(new TransportError('no code'))).toBe(true);
    expect(isTransient(new TransportError('unknown', 'E_NOT_IN_THE_TABLE'))).toBe(false);
  });

  it('says a code that comes after bytes may have gone out: only the early codes are "before any byte"', () => {
    for (const code of ['E_TIMEOUT', 'E_WRITE', 'E_READ', 'E_DISCONNECTED', 'E_CANCELLED']) {
      expect([code, errorCodeInfo(code)?.beforeAnyByte]).toEqual([code, false]);
    }
    for (const code of ['E_PERMISSION', 'E_BLUETOOTH_OFF', 'E_CONNECT', 'E_NOT_CONNECTED', 'E_NO_CHARACTERISTIC']) {
      expect([code, errorCodeInfo(code)?.beforeAnyByte]).toEqual([code, true]);
    }
  });
});
