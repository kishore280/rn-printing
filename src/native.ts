import { NativeModuleMissingError } from './errors';
import type { BplzCodec } from './specs/BplzCodec.nitro';
import type { BluetoothLE } from './specs/BluetoothLE.nitro';
import type { ClassicBluetooth } from './specs/ClassicBluetooth.nitro';

/**
 * Lazy access to the native (Nitro) objects. `require` runs inside a function, so
 * Jest or a bundle without the native module can still load this package.
 * There is no JavaScript copy of the native code. When the codec is missing,
 * requireCodec() throws NativeModuleMissingError.
 * Tests can inject a double with setNativeCodec().
 */
let codec: BplzCodec | null | undefined;
let classic: ClassicBluetooth | null | undefined;
let ble: BluetoothLE | null | undefined;

function create<T extends object>(name: string): T | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { NitroModules } = require('react-native-nitro-modules') as typeof import('react-native-nitro-modules');
    return NitroModules.createHybridObject<T & import('react-native-nitro-modules').HybridObject<{}>>(name) as T;
  } catch {
    return null;
  }
}

/** The C++ codec, or null. */
export function getNativeCodec(): BplzCodec | null {
  if (codec === undefined) codec = create<BplzCodec>('BplzCodec');
  return codec;
}

/** The C++ codec. Throws NativeModuleMissingError when it is not linked. */
export function requireCodec(): BplzCodec {
  const c = getNativeCodec();
  if (!c) throw new NativeModuleMissingError('BplzCodec');
  return c;
}

/** Use your own codec (a test double, or a custom build). Pass `undefined` to look for the native one again. */
export function setNativeCodec(value: BplzCodec | null | undefined): void {
  codec = value;
}

/** The Android Bluetooth Classic object, or null. */
export function getClassicBluetooth(): ClassicBluetooth | null {
  if (classic === undefined) classic = create<ClassicBluetooth>('ClassicBluetooth');
  return classic;
}

export function setClassicBluetooth(value: ClassicBluetooth | null | undefined): void {
  classic = value;
}

/** The Bluetooth Low Energy object (Android and iOS), or null. */
export function getBluetoothLE(): BluetoothLE | null {
  if (ble === undefined) ble = create<BluetoothLE>('BluetoothLE');
  return ble;
}

export function setBluetoothLE(value: BluetoothLE | null | undefined): void {
  ble = value;
}

/** An ArrayBuffer with exactly the bytes of `data`. Copies only when the view is a slice of a bigger buffer. */
export function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) return data.buffer as ArrayBuffer;
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}
