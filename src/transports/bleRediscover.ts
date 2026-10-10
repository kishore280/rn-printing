import { TransportError } from '../errors';
import type { BleConnection } from '../specs/BleConnection.nitro';
import type { BluetoothLE as NativeBluetoothLE } from '../specs/BluetoothLE.nitro';
import { wrap } from './bleCommon';

/** What the caller saved about the device from a scan. The package has no built-in value. */
export interface RediscoverHint {
  name: string | null;
  serviceUuids: string[];
}

const FIND_SCAN_MS = 4000;

/**
 * iOS gives each device an id that is private to the phone. The id can change when the printer uses a resolvable private address and the
 * phone forgot the old one (for example after the system cache was cleared). Then `connect` fails with `E_DEVICE_NOT_FOUND`.
 * Scan once, with the saved services as the platform filter, and keep the devices with the saved name. Use the result only when exactly
 * one device fits: two printers with the same name must never be mixed up, because a label would print on the wrong one.
 */
export async function findAgain(mod: NativeBluetoothLE, hint: RediscoverHint): Promise<string> {
  const found = new Set<string>();
  await wrap(
    mod.scan({ serviceUuids: hint.serviceUuids, timeoutMs: FIND_SCAN_MS, allowDuplicates: false }, (r) => {
      if (hint.name === null || r.name === hint.name) found.add(r.id);
    }),
    'E_SCAN_FAILED'
  );
  const [only] = [...found];
  if (found.size === 1 && only !== undefined) return only;
  const why = found.size === 0 ? 'No device with the saved name or services is near.' : 'More than one device fits the saved name or services.';
  throw new TransportError(`${why} Scan and choose the printer again.`, 'E_DEVICE_NOT_FOUND');
}

/**
 * Open a link to `id`. When the phone does not know the id and the caller allowed it (`hint` is not null), look for the device again
 * and open that one. The id that worked is returned, so the caller can keep it.
 */
export async function connectOrFind(
  mod: NativeBluetoothLE,
  id: string,
  hint: RediscoverHint | null,
  timeoutMs: number,
  onDisconnect: (reason: string) => void
): Promise<{ link: BleConnection; id: string }> {
  try {
    return { link: await wrap(mod.connect(id, timeoutMs, onDisconnect), 'E_CONNECT'), id };
  } catch (e) {
    if (hint === null || (e as { code?: string }).code !== 'E_DEVICE_NOT_FOUND') throw e;
    const found = await findAgain(mod, hint);
    return { link: await wrap(mod.connect(found, timeoutMs, onDisconnect), 'E_CONNECT'), id: found };
  }
}

/** The name and services of a scan result, kept to find the device again. null when the caller saved neither: nothing to search with. */
export function hintOf(device: { name?: string | null; serviceUuids?: string[] }): RediscoverHint | null {
  const name = device.name ? device.name : null;
  const serviceUuids = device.serviceUuids ?? [];
  return name === null && serviceUuids.length === 0 ? null : { name, serviceUuids };
}
