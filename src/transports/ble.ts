import { base64Decode, base64Encode } from '../encoding';
import { TransportError } from '../errors';
import type { ReadOptions, Transport } from '../transport';
import { Inbox } from './inbox';

export interface BleCharacteristicInfo {
  serviceUuid: string;
  uuid: string;
  writable: boolean;
  writableWithoutResponse: boolean;
  notifiable: boolean;
}

/**
 * The small BLE interface this package needs. Use `blePlxClient()` for
 * `react-native-ble-plx`, or write your own adapter for another BLE library.
 */
export interface BleClient {
  connect(deviceId: string): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): Promise<boolean>;
  discover(): Promise<BleCharacteristicInfo[]>;
  write(
    serviceUuid: string,
    characteristicUuid: string,
    data: Uint8Array,
    withResponse: boolean
  ): Promise<void>;
  /** Largest write the link takes, in bytes (the agreed MTU minus 3). Optional. */
  maxWriteSize?(): number | undefined;
  /** Returns a function that stops the subscription. */
  subscribe(
    serviceUuid: string,
    characteristicUuid: string,
    onData: (data: Uint8Array) => void
  ): Promise<() => void>;
}

export interface BleTransportOptions {
  /** Bluetooth Low Energy device id: the MAC address on Android, a UUID on iOS. */
  deviceId: string;
  client: BleClient;
  /** Write characteristic. When missing, the first writable one is used. */
  serviceUuid?: string | undefined;
  writeCharacteristicUuid?: string | undefined;
  /** Reply characteristic. When missing, a notifiable one in the same service is used. */
  notifyCharacteristicUuid?: string | undefined;
  /** Bytes per write. Default: what the BLE client reports as the largest write, else 20 (the smallest BLE packet). */
  chunkSize?: number | undefined;
  /** Delay between writes in ms. Default 0. */
  chunkDelayMs?: number | undefined;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Bluetooth Low Energy link. Works on Android and iOS.
 *
 * The GATT UUIDs of the SNBC BTP-4200E BLE module are NOT known yet. Leave the
 * UUIDs empty and the first writable characteristic is used. Call `discover()`
 * to see the list, then set the right UUIDs.
 */
export class BleTransport implements Transport {
  private readonly inbox = new Inbox();
  private unsubscribe: (() => void) | null = null;
  private target: { service: string; write: string; withResponse: boolean } | null = null;

  constructor(private readonly options: BleTransportOptions) {}


  async discover(): Promise<BleCharacteristicInfo[]> {
    return this.options.client.discover();
  }

  async connect(): Promise<void> {
    const { client, deviceId } = this.options;
    try {
      await client.connect(deviceId);
      const list = await client.discover();
      const write = this.pickWrite(list);
      if (!write) throw new TransportError('No writable BLE characteristic found', 'E_NO_CHARACTERISTIC');
      const notify = this.pickNotify(list, write);
      this.target = {
        service: write.serviceUuid,
        write: write.uuid,
        withResponse: !write.writableWithoutResponse,
      };
      if (notify) {
        this.unsubscribe = await client.subscribe(notify.serviceUuid, notify.uuid, (d) => this.inbox.push(d));
      }
    } catch (e) {
      await client.disconnect().catch(() => undefined);
      throw e instanceof TransportError ? e : new TransportError(messageOf(e), 'E_CONNECT');
    }
  }

  async disconnect(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.target = null;
    this.inbox.clear();
    await this.options.client.disconnect();
  }

  isConnected(): Promise<boolean> {
    return this.options.client.isConnected();
  }

  async write(data: Uint8Array): Promise<void> {
    const t = this.target;
    if (!t) throw new TransportError('Not connected', 'E_NOT_CONNECTED');
    const size = Math.max(1, this.options.chunkSize ?? this.options.client.maxWriteSize?.() ?? 20);
    const delay = this.options.chunkDelayMs ?? 0;
    try {
      for (let offset = 0; offset < data.length; offset += size) {
        await this.options.client.write(t.service, t.write, data.subarray(offset, offset + size), t.withResponse);
        if (delay > 0 && offset + size < data.length) await new Promise<void>((r) => setTimeout(r, delay));
      }
    } catch (e) {
      throw new TransportError(messageOf(e), 'E_WRITE');
    }
  }

  read(options: ReadOptions = {}): Promise<Uint8Array> {
    return this.inbox.read(options);
  }

  private pickWrite(list: BleCharacteristicInfo[]): BleCharacteristicInfo | undefined {
    const { serviceUuid, writeCharacteristicUuid } = this.options;
    return list.find(
      (c) =>
        (c.writable || c.writableWithoutResponse) &&
        (!serviceUuid || same(c.serviceUuid, serviceUuid)) &&
        (!writeCharacteristicUuid || same(c.uuid, writeCharacteristicUuid))
    );
  }

  private pickNotify(list: BleCharacteristicInfo[], write: BleCharacteristicInfo): BleCharacteristicInfo | undefined {
    const { notifyCharacteristicUuid } = this.options;
    if (notifyCharacteristicUuid) return list.find((c) => same(c.uuid, notifyCharacteristicUuid));
    return list.find((c) => c.notifiable && same(c.serviceUuid, write.serviceUuid));
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---- Adapter for react-native-ble-plx (typed by shape, so there is no hard dependency) ----

interface PlxCharacteristic {
  uuid: string;
  serviceUUID: string;
  isWritableWithResponse: boolean;
  isWritableWithoutResponse: boolean;
  isNotifiable: boolean;
  isIndicatable: boolean;
  value: string | null;
}
interface PlxService {
  uuid: string;
  characteristics(): Promise<PlxCharacteristic[]>;
}
interface PlxDevice {
  mtu: number;
  discoverAllServicesAndCharacteristics(): Promise<PlxDevice>;
  services(): Promise<PlxService[]>;
  isConnected(): Promise<boolean>;
  cancelConnection(): Promise<unknown>;
  writeCharacteristicWithResponseForService(s: string, c: string, base64: string): Promise<unknown>;
  writeCharacteristicWithoutResponseForService(s: string, c: string, base64: string): Promise<unknown>;
  monitorCharacteristicForService(
    s: string,
    c: string,
    listener: (error: unknown, characteristic: PlxCharacteristic | null) => void
  ): { remove(): void };
}
export interface BlePlxManagerLike {
  connectToDevice(deviceId: string, options?: { requestMTU?: number }): Promise<PlxDevice>;
}


export interface BlePlxClientOptions {
  /** Used on Android only. */
  requestMtu?: number | undefined;
}

/**
 * Adapter for `react-native-ble-plx`. Pass your `BleManager`:
 * `blePlxClient(new BleManager())`.
 */
export function blePlxClient(manager: BlePlxManagerLike, options: BlePlxClientOptions = {}): BleClient {
  let device: PlxDevice | null = null;
  const need = (): PlxDevice => {
    if (!device) throw new TransportError('Not connected', 'E_NOT_CONNECTED');
    return device;
  };
  return {
    async connect(deviceId) {
      const mtu = options.requestMtu ? { requestMTU: options.requestMtu } : undefined;
      device = await manager.connectToDevice(deviceId, mtu);
      await device.discoverAllServicesAndCharacteristics();
    },
    async disconnect() {
      const d = device;
      device = null;
      if (d) await d.cancelConnection().catch(() => undefined);
    },
    async isConnected() {
      return device ? device.isConnected() : false;
    },
    maxWriteSize() {
      // The ATT header takes 3 bytes. iOS reports the largest write for the link in `mtu` too.
      return device && device.mtu > 23 ? device.mtu - 3 : undefined;
    },
    async discover() {
      const out: BleCharacteristicInfo[] = [];
      for (const service of await need().services()) {
        for (const c of await service.characteristics()) {
          out.push({
            serviceUuid: service.uuid,
            uuid: c.uuid,
            writable: c.isWritableWithResponse,
            writableWithoutResponse: c.isWritableWithoutResponse,
            notifiable: c.isNotifiable || c.isIndicatable,
          });
        }
      }
      return out;
    },
    async write(service, characteristic, data, withResponse) {
      const b64 = base64Encode(data);
      if (withResponse) await need().writeCharacteristicWithResponseForService(service, characteristic, b64);
      else await need().writeCharacteristicWithoutResponseForService(service, characteristic, b64);
    },
    async subscribe(service, characteristic, onData) {
      const sub = need().monitorCharacteristicForService(service, characteristic, (error, c) => {
        if (!error && c?.value) onData(base64Decode(c.value));
      });
      return () => sub.remove();
    },
  };
}
