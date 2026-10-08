/**
 * Names and decoders for the standard Bluetooth SIG attributes (16-bit UUIDs). Pure TypeScript, no native code.
 * Sources: Bluetooth SIG Assigned Numbers (services and characteristics) and the GATT Specification Supplement.
 * Only a short list is here, the ones that a printer is likely to have. A UUID not in the list has no name:
 * a vendor UUID (128-bit) is never named, because this package has no list of vendor UUIDs on purpose.
 */
import { latin1Decode, utf8Decode } from '../encoding';

/** The 16-bit form of a Bluetooth base UUID (`0000xxxx-0000-1000-8000-00805f9b34fb`), or null for any other UUID. */
export function shortUuid(uuid: string): string | null {
  const m = /^(?:0000)?([0-9a-f]{4})(?:-0000-1000-8000-00805f9b34fb)?$/i.exec(uuid.trim());
  return m?.[1] ? m[1].toLowerCase() : null;
}

const SERVICES: Record<string, string> = {
  '1800': 'Generic Access',
  '1801': 'Generic Attribute',
  '180a': 'Device Information',
  '180f': 'Battery',
  '1812': 'Human Interface Device',
  '1805': 'Current Time',
  '180d': 'Heart Rate',
  '181c': 'User Data',
};

const CHARACTERISTICS: Record<string, string> = {
  '2a00': 'Device Name',
  '2a01': 'Appearance',
  '2a04': 'Peripheral Preferred Connection Parameters',
  '2a05': 'Service Changed',
  '2a19': 'Battery Level',
  '2a23': 'System ID',
  '2a24': 'Model Number',
  '2a25': 'Serial Number',
  '2a26': 'Firmware Revision',
  '2a27': 'Hardware Revision',
  '2a28': 'Software Revision',
  '2a29': 'Manufacturer Name',
  '2a2a': 'IEEE 11073-20601 Regulatory Certification Data List',
  '2a50': 'PnP ID',
  '2aa6': 'Central Address Resolution',
};

/** The Bluetooth SIG name of a service UUID, or null. */
export function serviceName(uuid: string): string | null {
  const s = shortUuid(uuid);
  return (s && SERVICES[s]) || null;
}

/** The Bluetooth SIG name of a characteristic UUID, or null. */
export function characteristicName(uuid: string): string | null {
  const s = shortUuid(uuid);
  return (s && CHARACTERISTICS[s]) || null;
}

/** Hex text, for example `0A 1F`. */
export function hexBytes(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function isPrintable(bytes: Uint8Array): boolean {
  return bytes.length > 0 && bytes.every((b) => b >= 0x20 && b < 0x7f);
}

const STRING_CHARACTERISTICS = new Set(['2a00', '2a24', '2a25', '2a26', '2a27', '2a28', '2a29']);

/** Text for a value: the standard decoding when the UUID is known, else the text when every byte prints, else null. */
export function decodeValue(characteristicUuid: string, bytes: Uint8Array): string | null {
  const s = shortUuid(characteristicUuid);
  if (s && STRING_CHARACTERISTICS.has(s)) {
    // Values can end with NUL bytes. UTF-8 is the format (GATT Specification Supplement, "utf8s").
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--;
    return utf8Decode(bytes.subarray(0, end));
  }
  if (s === '2a19' && bytes.length >= 1) return `${bytes[0]} %`;
  if (s === '2a01' && bytes.length >= 2) return `category ${((bytes[1] ?? 0) << 2) | ((bytes[0] ?? 0) >> 6)}`;
  if (s === '2a50' && bytes.length >= 7) {
    const u16 = (i: number) => (bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8);
    const source = bytes[0] === 1 ? 'Bluetooth SIG' : bytes[0] === 2 ? 'USB' : `source ${bytes[0]}`;
    return `${source}, vendor 0x${u16(1).toString(16).padStart(4, '0')}, product 0x${u16(3).toString(16).padStart(4, '0')}, version 0x${u16(5)
      .toString(16)
      .padStart(4, '0')}`;
  }
  if (s === '2a04' && bytes.length >= 8) {
    const u16 = (i: number) => (bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8);
    return `interval ${(u16(0) * 1.25).toFixed(2)}-${(u16(2) * 1.25).toFixed(2)} ms, latency ${u16(4)}, timeout ${u16(6) * 10} ms`;
  }
  if (s === '2aa6' && bytes.length >= 1) return bytes[0] === 1 ? 'supported' : 'not supported';
  return isPrintable(bytes) ? latin1Decode(bytes) : null;
}
