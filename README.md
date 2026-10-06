# react-native-bplz-label-printer

Print labels from React Native to SNBC-family label printers (BTP-4200E, sold as TVS LP 46 D Lite).
It speaks all three SNBC command sets:

| Set | Language | Builder |
| --- | --- | --- |
| BPLZ | ZPL II emulation | `ZplLabel` |
| BPLC | CPCL style | `CpclLabel` |
| BPLA | Datamax style records | `BplaLabel` (least checked) |

This package has no link with SNBC or TVS. It has no SNBC code or binaries.

## Status. Read this first.

- **Nothing is tested on a real printer.** See [docs/REFERENCES.md](docs/REFERENCES.md) for what each part was checked against.
- The TypeScript code is type-checked (strict) and unit-tested. The C++ core is compared with a TypeScript reference on random data.
- The Kotlin code compiles against the Android 14 API and the real Nitro sources. It has not run on a device.
- Find the real command set first: print the self-test label and read the `COMMAND` line.
- BLE: `BluetoothLETransport` finds the GATT table at run time. No UUID is built in. See [docs/BLE.md](docs/BLE.md). Its Kotlin code compiles; its Swift code is not compiled yet; nothing ran on a device or printer.

## How it is built

- The image work (dither, ZPL compression) is C++ (`cpp/`), shared by Android and iOS, called through [Nitro Modules](https://nitro.margelo.com). Bytes cross as `ArrayBuffer`, with no base64 step, and the work runs off the JS thread.
- Bluetooth Classic is a Kotlin Nitro object (`ClassicBluetooth` and `ClassicConnection`).
- Bluetooth Low Energy is a Nitro object too (`BluetoothLE` and `BleConnection`): Kotlin on Android (`BluetoothLeScanner`, `BluetoothGatt`), Swift on iOS (CoreBluetooth).
- There is **no JavaScript copy** of the native code. If the native module is missing you get a `NativeModuleMissingError`, not a slow silent path. The TypeScript reference lives in `test/reference/` and only checks the C++.
- Label builders (`ZplLabel`, `CpclLabel`, `BplaLabel`) and the transports are TypeScript. They are not hot paths.

## Links

| Link | Android | iOS |
| --- | --- | --- |
| Bluetooth Classic (SPP) | yes (`BluetoothClassicTransport`) | **no.** Apple allows it only with MFi. |
| BLE | yes (`BluetoothLETransport`) | yes (`BluetoothLETransport`) |
| TCP port 9100 (Ethernet / WiFi option) | yes | yes |

The TVS LP 46 Dlite has a BLE module. The BLE code does not need its UUIDs: it reads the GATT table after the connect. See [docs/BLE.md](docs/BLE.md).

## Install

```sh
npm install react-native-bplz-label-printer react-native-nitro-modules
npm install react-native-ble-plx        # only for the older BleTransport. BluetoothLETransport does not need it
npm install react-native-tcp-socket     # only for TCP
cd ios && pod install
```

The native code needs a development build. It does not run in Expo Go.

### iOS settings (Info.plist)

- BLE: `NSBluetoothAlwaysUsageDescription` (iOS shows the dialog at the first scan or connect).
- TCP to a printer on the local network: `NSLocalNetworkUsageDescription`.

### Android permissions

The library adds `BLUETOOTH_CONNECT` and `BLUETOOTH_SCAN` (Android 12+), `ACCESS_FINE_LOCATION` (Android 11 and older, for BLE scans) and the old `BLUETOOTH` permissions.
Call `BluetoothClassic.requestPermissions()` before you list paired devices. Call `BluetoothLE.requestPermissions()` before a BLE scan.

## Use

```ts
import {
  BluetoothClassic, BluetoothClassicTransport, LabelPrinter, ZplLabel,
} from 'react-native-bplz-label-printer';

await BluetoothClassic.requestPermissions();
const [printer] = await BluetoothClassic.getPairedDevices();

const lp = new LabelPrinter(new BluetoothClassicTransport(printer.address));
await lp.connect();

const label = ZplLabel.fromMm(50, 30) // 203 dpi: 8 dots per mm
  .text(20, 20, 'Hello', { height: 40 })
  .barcode128(20, 80, '12345678', { height: 70 })
  .qr(300, 90, 'https://example.com', { magnification: 3 });

await lp.print(label);
await lp.disconnect();
```

### CPCL (BPLC)

```ts
const label = CpclLabel.fromMm(50, 30)
  .text(10, 10, 'Hello', { size: 1 })
  .barcode128(10, 60, '12345678')
  .qr(250, 60, 'https://example.com');
await lp.print(label);
```

### BPLA

The origin is the **bottom-left** corner.

```ts
await lp.print(new BplaLabel().text(150, 20, 'Hello').barcode128(60, 20, '12345678').quantity(1));
```

### Images

Decode the picture to pixels with another library (for example a canvas or a decoder library). Then:

```ts
import { ditherRgba, compressBitmap, ZplLabel } from 'react-native-bplz-label-printer';

const bitmap = await ditherRgba(rgba, width, height, { method: 'atkinson' }); // runs in C++, off the JS thread
const body = await compressBitmap(bitmap);                                     // ZPL ASCII compression
await lp.print(new ZplLabel({ widthDots: 400, lengthDots: 240 }).image(0, 0, bitmap, body));
```

Dither methods: `threshold` (text, line art), `floyd-steinberg` and `atkinson` (photos), `bayer`.
`CpclLabel.image(x, y, bitmap)` sends raw bytes and needs no compression.

To send a logo once and reuse it: `lp.print(zplDownloadImage('logo', bitmap, body))`, then `label.recall(x, y, 'logo')`.

### BLE

```ts
import { BluetoothLE, BluetoothLETransport, bleFilters, LabelPrinter } from 'react-native-bplz-label-printer';

await BluetoothLE.requestPermissions();
const devices = await BluetoothLE.scan({ timeoutMs: 6000, filter: bleFilters.name(/LP ?46/i) });
const lp = new LabelPrinter(new BluetoothLETransport(devices[0]!)); // finds the write characteristic by itself
await lp.print(label);
```

Scan, GATT discovery, write type, piece size, flow control, errors, troubleshooting and a manual test plan: [docs/BLE.md](docs/BLE.md).

The older `BleTransport` with `react-native-ble-plx` still works:

```ts
const transport = new BleTransport({ deviceId, client: blePlxClient(new BleManager(), { requestMtu: 185 }) });
```

### TCP

```ts
import TcpSocket from 'react-native-tcp-socket';
const lp = new LabelPrinter(new TcpTransport({ host: '192.168.1.50', createConnection: TcpSocket.createConnection }));
```

### Status and settings

- `await lp.getStatus()` sends `~HS` (BPLZ). It returns `null` when the printer does not answer.
- `await lp.getExtendedStatus()` sends `~HQES` (BPLZ).
- `zplSettings` (print mode, media, speed, darkness, calibrate) and `cpclSettings` build setup commands. Send them with `lp.print(string)`.

## If a label comes out cut

Use `new BluetoothClassicTransport(addr, { chunkDelayMs: 20 })`.

## Add a new link

Write a class with the `Transport` interface (`connect`, `disconnect`, `isConnected`, `write`, `read`).

## More

- [Teardown findings](docs/TEARDOWN.md): what the SNBC SDK and apps showed.

## Licence

MIT

## Development

CI runs on GitHub Actions (`.github/workflows/ci.yml`): typecheck, tests, build, a check that `nitrogen/generated` is current, a C++ syntax check, and a Kotlin compile check.
Agents and new contributors: read [AGENTS.md](./AGENTS.md) first.

## Reconnect

`LabelPrinter` connects by itself when the link is closed, and retries a failed connect.
The app does not need its own reconnect loop. The app still shows the device list, asks for permissions and picks the printer.

```ts
const printer = new LabelPrinter(transport, {
  reconnect: { maxAttempts: 3, initialDelayMs: 300, backoffMultiplier: 2, maxDelayMs: 2000, jitter: true },
  onConnectionEvent: (e) => console.log(e.type), // connecting | retry | connected | failed
});
await printer.print(label); // connects first if needed
```

Rules:
- Retry uses [cockatiel](https://github.com/connor4312/cockatiel) (MIT): exponential backoff with decorrelated jitter. One layer for every transport.
- `maxAttempts` counts the first try. `reconnect: false` means one attempt.
- Only transient errors are retried (`E_CONNECT`, `E_TIMEOUT`, `E_NOT_CONNECTED`, `E_WRITE`, `E_READ`).
  Errors the user must fix are not retried: `E_PERMISSION`, `E_BLUETOOTH_OFF`, `E_BAD_ADDRESS`, `E_NO_ADAPTER`.
- If a write fails, the job is NOT sent again, because part of the label may be printing. The link is closed, and the next job reconnects.
  Exceptions: a job that failed with `E_NOT_CONNECTED` (no byte was sent) and status queries are sent again once.
  Set `resendAfterPartialWrite: true` to send again after any write failure. This is not tested on the real unit.
- There is no background reconnect. A reconnect runs when a job starts.

