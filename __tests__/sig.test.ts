import { characteristicName, decodeValue, hexBytes, serviceName, shortUuid } from '../src/transports/sig';

const base = (s: string) => `0000${s}-0000-1000-8000-00805f9b34fb`;

describe('sig', () => {
  it('reads the 16-bit form of a base UUID and nothing else', () => {
    expect(shortUuid(base('2A00'))).toBe('2a00');
    expect(shortUuid('180f')).toBe('180f');
    expect(shortUuid('49535343-fe7d-4ae5-8fa9-9fafd205e455')).toBeNull();
  });

  it('names standard attributes only', () => {
    expect(serviceName(base('180a'))).toBe('Device Information');
    expect(characteristicName(base('2a29'))).toBe('Manufacturer Name');
    expect(characteristicName('49535343-8841-43f4-a8d4-ecbe34729bb3')).toBeNull();
  });

  it('decodes standard values', () => {
    expect(decodeValue(base('2a24'), new Uint8Array([0x4c, 0x50, 0, 0]))).toBe('LP');
    expect(decodeValue(base('2a19'), new Uint8Array([87]))).toBe('87 %');
    expect(decodeValue(base('2a50'), new Uint8Array([1, 0x0d, 0x00, 0x10, 0x00, 0x01, 0x02]))).toBe(
      'Bluetooth SIG, vendor 0x000d, product 0x0010, version 0x0201'
    );
    expect(decodeValue(base('2a04'), new Uint8Array([0x10, 0, 0x20, 0, 0, 0, 0x90, 0x01]))).toBe('interval 20.00-40.00 ms, latency 0, timeout 4000 ms');
  });

  it('shows printable bytes of an unknown characteristic as text, others as null', () => {
    expect(decodeValue('11111111-0000-0000-0000-000000000001', new Uint8Array([0x41, 0x42]))).toBe('AB');
    expect(decodeValue('11111111-0000-0000-0000-000000000001', new Uint8Array([1, 2]))).toBeNull();
    expect(hexBytes(new Uint8Array([1, 0xab]))).toBe('01 AB');
  });
});
