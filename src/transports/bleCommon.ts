import { TransportError, UnsupportedPlatformError } from '../errors';
import { getBluetoothLE } from '../native';
import type { BleScanResult } from '../specs/BleScanResult';
import type { BluetoothLE as NativeBluetoothLE } from '../specs/BluetoothLE.nitro';
import type { BleDevice } from './bleTypes';


/**
 * Nitro passes only the message of a native error. The native side puts a code first,
 * like `[E_BLUETOOTH_OFF] Bluetooth is off`. If you change a code there, change this too.
 * Errors that the user must fix keep their own code, so the reconnect logic does not retry them.
 */
export function classify(error: unknown, fallback: string): TransportError {
  if (error instanceof TransportError) return error;
  const raw = error instanceof Error ? error.message : String(error);
  // Nitro puts the Java class name before the message and the stack after it on Android
  // (`com.margelo.nitro.bplzlabel.a: [E_BLUETOOTH_OFF] Bluetooth is off\n  at ...`). So the code is searched in the
  // text, and the message is the rest of that line.
  const m = /\[(E_[A-Z_]+)\][ \t]*([^\r\n]*)/.exec(raw);
  if (m) return new TransportError(m[2]?.trim() || m[1] || raw, m[1]);
  return new TransportError(firstLine(raw), fallback);
}

/** The first line of a message, without a leading Java class name: the stack of a native error is not for the user. */
function firstLine(text: string): string {
  const line = (text.split(/\r?\n/)[0] ?? text).trim();
  return line.replace(/^(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*:\s+/, '') || text.trim();
}

export async function wrap<T>(job: Promise<T> | T, fallback: string): Promise<T> {
  try {
    return await job;
  } catch (e) {
    throw classify(e, fallback);
  }
}

export function native(): NativeBluetoothLE {
  const mod = getBluetoothLE();
  if (!mod) {
    throw new UnsupportedPlatformError(
      'The native BLE object is not available. Rebuild the app after installing the package, and do not use Expo Go.'
    );
  }
  return mod;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function toDevice(r: BleScanResult): BleDevice {
  return {
    id: r.id,
    name: r.name === '' ? null : r.name,
    rssi: r.rssi ?? null,
    connectable: r.connectable,
    serviceUuids: r.serviceUuids,
    manufacturerData: r.manufacturerData === '' ? null : r.manufacturerData,
    txPower: r.txPower ?? null,
  };
}


export function stripUndefined<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}
