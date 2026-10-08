import { TransportError } from '../errors';
import type { BleCharacteristic } from '../specs/BleCharacteristic';

/** One GATT characteristic with its properties. Same shape as the native object. */
export type BleGattCharacteristic = BleCharacteristic;

/**
 * Which kind of GATT write to use.
 * - `'write'`: write with response. The stack confirms each piece. Slower, safest.
 * - `'withoutResponse'`: write without response. Faster. The transport paces the pieces.
 * - `'auto'` (default): write without response when the characteristic has it, else write with response.
 */
export type BleWriteMode = 'auto' | 'write' | 'withoutResponse';

/** What the transport uses to send and to listen. */
export interface BleSelection {
  /** The characteristic that receives the printer bytes. */
  write: BleGattCharacteristic;
  /** True: "write with response" (each piece is confirmed). False: "write without response". */
  withResponse: boolean;
  /** The characteristic for replies from the printer. null when there is none. */
  notify: BleGattCharacteristic | null;
  /** A short text that tells why these were chosen. For logs. */
  reason: string;
  /** Other writable characteristics that scored the same. Not empty means the pick was a guess. */
  alternatives: BleGattCharacteristic[];
}

/** A function that picks the characteristics. Return `undefined` when none fits. */
export type BleSelector = (gatt: readonly BleGattCharacteristic[]) => Pick<BleSelection, 'write' | 'notify'> & { withResponse?: boolean } | undefined;

export interface BleSelectionOptions {
  /** Use only this service. */
  serviceUuid?: string | undefined;
  /** Use this characteristic for writes. */
  writeCharacteristicUuid?: string | undefined;
  /** Use this characteristic for replies. */
  notifyCharacteristicUuid?: string | undefined;
  /** Your own rule. It runs instead of the built-in rule. */
  select?: BleSelector | undefined;
  /** Default 'auto': write without response when the characteristic has it. */
  writeMode?: BleWriteMode | undefined;
  /** Throw when two or more writable characteristics fit equally well. Default false. */
  strictSelection?: boolean | undefined;
}

const BASE_SUFFIX = '-0000-1000-8000-00805f9b34fb';

/** Lower case 128-bit form. Accepts 16-bit, 32-bit and 128-bit UUIDs, with or without dashes. */
export function normalizeUuid(uuid: string): string {
  const t = uuid.trim().toLowerCase().replace(/^0x/, '');
  if (/^[0-9a-f]{4}$/.test(t)) return `0000${t}${BASE_SUFFIX}`;
  if (/^[0-9a-f]{8}$/.test(t)) return `${t}${BASE_SUFFIX}`;
  if (/^[0-9a-f]{32}$/.test(t)) return `${t.slice(0, 8)}-${t.slice(8, 12)}-${t.slice(12, 16)}-${t.slice(16, 20)}-${t.slice(20)}`;
  return t;
}


/**
 * Bluetooth SIG services that hold device information, not data for an application:
 * Generic Access (1800), Generic Attribute (1801) and Device Information (180A).
 * These are skipped by the built-in rule. They are not printer specific.
 */
const SKIPPED_SERVICES = ['1800', '1801', '180a'].map(normalizeUuid);

const canWrite = (c: BleGattCharacteristic): boolean => c.write || c.writeWithoutResponse;
const canNotify = (c: BleGattCharacteristic): boolean => c.notify || c.indicate;
const sameUuid = (a: string, b: string): boolean => normalizeUuid(a) === normalizeUuid(b);

const same = (a: BleGattCharacteristic, b: BleGattCharacteristic): boolean => sameUuid(a.serviceUuid, b.serviceUuid) && sameUuid(a.uuid, b.uuid);

/** A readable list of the GATT table, one line per characteristic. For logs and error messages. */
export function describeGatt(gatt: readonly BleGattCharacteristic[]): string {
  if (gatt.length === 0) return '(no characteristics)';
  return gatt
    .map((c) => {
      const flags = [
        c.read && 'read',
        c.write && 'write',
        c.writeWithoutResponse && 'writeWithoutResponse',
        c.notify && 'notify',
        c.indicate && 'indicate',
      ].filter(Boolean);
      return `service ${c.serviceUuid} characteristic ${c.uuid} [${flags.join(', ') || 'none'}]`;
    })
    .join('\n');
}

function noMatch(why: string, gatt: readonly BleGattCharacteristic[]): TransportError {
  return new TransportError(
    `${why}\nThe device offers:\n${describeGatt(gatt)}\n` +
      'Pass serviceUuid and writeCharacteristicUuid, or a select() function, to choose by hand.',
    'E_NO_CHARACTERISTIC'
  );
}

function resolveWriteType(c: BleGattCharacteristic, mode: BleWriteMode, gatt: readonly BleGattCharacteristic[]): boolean {
  if (mode === 'write') {
    if (!c.write) throw noMatch(`Characteristic ${c.uuid} does not support write with response.`, gatt);
    return true;
  }
  if (mode === 'withoutResponse') {
    if (!c.writeWithoutResponse) throw noMatch(`Characteristic ${c.uuid} does not support write without response.`, gatt);
    return false;
  }
  // auto: serial-over-BLE printers take write without response, and it is much faster than a confirmed write.
  // Pieces are paced and wait for the stack (see BluetoothLETransport). Use `writeMode: 'write'` if labels come out cut.
  return !c.writeWithoutResponse;
}

/**
 * Choose the write and reply characteristics from the discovered GATT table.
 * No UUID is built in. The rule, in order:
 *
 * 1. `select()` from the caller, when given.
 * 2. The caller's `serviceUuid` / `writeCharacteristicUuid` / `notifyCharacteristicUuid` narrow the search.
 * 3. Only writable characteristics count. Generic Access, Generic Attribute and Device Information are skipped.
 * 4. Score: +4 when the service also has a notify/indicate characteristic (a serial-style pair),
 *    +2 when the characteristic does both kinds of write, +1 when it cannot notify itself,
 *    +1 when it cannot be read (a data input is write-only; one that can also be read is usually a setting).
 * 5. The best score wins. Equal scores keep the discovery order, and the others are listed in `alternatives`
 *    (with `strictSelection` they throw instead).
 *
 * This is a heuristic. It is not checked on a range of printers. Use `alternatives` and `reason` to see what it did.
 */
export function selectCharacteristics(gatt: readonly BleGattCharacteristic[], options: BleSelectionOptions = {}): BleSelection {
  const mode = options.writeMode ?? 'auto';

  if (options.select) {
    const picked = options.select(gatt);
    if (!picked) throw noMatch('The select() function returned no characteristic.', gatt);
    if (!gatt.some((c) => same(c, picked.write))) throw noMatch('select() returned a characteristic that the device does not have.', gatt);
    const withResponse = picked.withResponse ?? resolveWriteType(picked.write, mode, gatt);
    return { write: picked.write, withResponse, notify: picked.notify ?? null, reason: 'chosen by select()', alternatives: [] };
  }

  const { serviceUuid, writeCharacteristicUuid, notifyCharacteristicUuid } = options;
  let candidates = gatt.filter(canWrite);
  if (serviceUuid) candidates = candidates.filter((c) => sameUuid(c.serviceUuid, serviceUuid));
  if (writeCharacteristicUuid) candidates = candidates.filter((c) => sameUuid(c.uuid, writeCharacteristicUuid));
  const explicit = !!(serviceUuid || writeCharacteristicUuid);
  if (!explicit) candidates = candidates.filter((c) => !SKIPPED_SERVICES.includes(normalizeUuid(c.serviceUuid)));
  if (mode === 'write') candidates = candidates.filter((c) => c.write);
  if (mode === 'withoutResponse') candidates = candidates.filter((c) => c.writeWithoutResponse);
  if (candidates.length === 0) throw noMatch('No writable characteristic matches.', gatt);

  const score = (c: BleGattCharacteristic): number => {
    const pair = gatt.some((o) => !same(o, c) && sameUuid(o.serviceUuid, c.serviceUuid) && canNotify(o));
    return (pair ? 4 : 0) + (c.write && c.writeWithoutResponse ? 2 : 0) + (canNotify(c) ? 0 : 1) + (c.read ? 0 : 1);
  };
  const best = Math.max(...candidates.map(score));
  const top = candidates.filter((c) => score(c) === best);
  const write = top[0] as BleGattCharacteristic;
  const alternatives = top.slice(1);
  if (alternatives.length > 0 && options.strictSelection && !explicit) {
    throw noMatch(`${top.length} writable characteristics fit equally well.`, top);
  }

  let notify: BleGattCharacteristic | null = null;
  if (notifyCharacteristicUuid) {
    notify = gatt.find((c) => sameUuid(c.uuid, notifyCharacteristicUuid) && (!serviceUuid || sameUuid(c.serviceUuid, serviceUuid))) ?? null;
    if (!notify) throw noMatch(`Notify characteristic ${notifyCharacteristicUuid} not found.`, gatt);
  } else {
    const pool = gatt.filter((c) => !same(c, write) && sameUuid(c.serviceUuid, write.serviceUuid) && canNotify(c));
    notify = pool.find((c) => c.notify) ?? pool[0] ?? null;
  }

  return {
    write,
    withResponse: resolveWriteType(write, mode, gatt),
    notify,
    reason: explicit ? 'narrowed by the UUIDs given by the caller' : `best score ${best} of ${candidates.length} writable characteristic(s)`,
    alternatives,
  };
}
