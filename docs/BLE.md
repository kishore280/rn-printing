# Bluetooth Low Energy (BLE) printing

BLE is a transport. It moves bytes. It does not know what the bytes mean.

```
ZplLabel / CpclLabel / BplaLabel  ->  bytes  ->  LabelPrinter  ->  Transport  ->  printer
                                                                   |- BluetoothClassicTransport (Android)
                                                                   |- BluetoothLETransport (Android + iOS)
                                                                   |- TcpTransport
```

- Android uses `BluetoothLeScanner` and `BluetoothGatt`. iOS uses CoreBluetooth (`CBCentralManager`, `CBPeripheral`).
  Both are called from Nitro objects (`BluetoothLE`, `BleConnection`). There is no third-party BLE library.
- No MAC address, device name, PIN or UUID is built in. The package finds the GATT table at run time.
- Bluetooth Classic (SPP) is not changed. BLE does not use the Classic PIN.
- The older `BleTransport` (with `react-native-ble-plx`) is still exported. New code should use `BluetoothLETransport`.

## Set up

### Android

The library adds these permissions to the manifest:

| Permission | Why |
| --- | --- |
| `BLUETOOTH_SCAN` (`neverForLocation`) | Scan on Android 12+. The flag says that you do not use the scan to find the phone's place. |
| `BLUETOOTH_CONNECT` | Connect on Android 12+. |
| `ACCESS_FINE_LOCATION` (up to Android 11) | Android 11 and older need it to scan. Also turn on the location switch of the phone: without it these versions return no results. |
| `BLUETOOTH`, `BLUETOOTH_ADMIN` (up to Android 11) | Old Bluetooth permissions. |

`uses-feature bluetooth_le` is `required="false"`, so the app can still install on a phone without BLE.
Ask the user at run time: `await BluetoothLE.requestPermissions()`.

### iOS

Add `NSBluetoothAlwaysUsageDescription` to Info.plist. Run `pod install`. iOS shows the permission dialog at the first scan or connect.
Bluetooth Classic is not available on iOS (Apple allows it only with MFi hardware). Use BLE or TCP.

## Use

```ts
import {
  BluetoothLE, BluetoothLETransport, bleFilters, LabelPrinter, ZplLabel,
} from 'react-native-bplz-label-printer';

if (!(await BluetoothLE.requestPermissions())) throw new Error('Bluetooth permission denied');

// 1. Scan. You decide what a printer is: the package does not guess.
const devices = await BluetoothLE.scan({
  timeoutMs: 6000,
  filter: bleFilters.name(/LP ?46/i),            // by name, service UUID, manufacturer data, RSSI, or your own function
  onDevice: (d) => console.log(d.name, d.rssi),   // fill a list while the scan runs
});

// 2. The user picks one. 3. Print.
const printer = new LabelPrinter(new BluetoothLETransport(devices[0]!));
await printer.print(ZplLabel.fromMm(50, 30).text(20, 20, 'Hello', { height: 40 }));
```

`new BluetoothLETransport(device)` takes a scan result or an id. `LabelPrinter` connects by itself, retries a connect that can work next time
(`E_CONNECT`, `E_TIMEOUT`, `E_DISCOVERY` ...) and does not retry errors that the user must fix (`E_PERMISSION`, `E_BLUETOOTH_OFF`, `E_AUTH` ...).

### Scan

| Option | Meaning |
| --- | --- |
| `timeoutMs` | Default 5000. `0` runs until `stopScan()` or `signal`. |
| `serviceUuids` | Platform filter: report only devices that advertise one of these services. Default: all. |
| `allowDuplicates` | Report a device again at each advertisement. Default false. |
| `filter(device)` | Your own filter in TypeScript. `bleFilters` has `name`, `serviceUuid`, `manufacturerData`, `minRssi`, `all`, `any`. |
| `onDevice(device)` | Called for each new device. |
| `signal` | An `AbortSignal`. Abort, or call `BluetoothLE.stopScan()`, to end the scan early. The promise resolves with what was found. |

A device has `id`, `name`, `rssi`, `connectable`, `serviceUuids`, `manufacturerData` (hex) and `txPower`.
The `id` is the MAC address on Android. On iOS it is a UUID that iOS makes for each phone. It is not the MAC and it can differ on another phone.

### See the GATT table

```ts
const gatt = await BluetoothLE.inspect(device);      // connect, discover, disconnect
console.log(describeGatt(gatt));
```

Or look at `transport.gatt` and `transport.selection` after `connect()`. `selection.reason` and `selection.alternatives` show how the choice was made.

### How the characteristics are chosen

`selectCharacteristics()` has no UUID. In order:

1. Your `select(gatt)` function, when you give one.
2. Your `serviceUuid`, `writeCharacteristicUuid`, `notifyCharacteristicUuid` narrow the search.
3. Only writable characteristics count. Generic Access (1800), Generic Attribute (1801) and Device Information (180A) are skipped.
4. Score: +4 if the service also has a notify/indicate characteristic (a serial pair), +2 if it supports both kinds of write, +1 if it cannot notify itself.
5. The best score wins. On a tie, the first one found wins and the rest are in `selection.alternatives`. With `strictSelection: true` a tie throws.

This rule is a heuristic. It has been run only on test data and on one layout that a user reported (see "Tested hardware"). If it picks wrong for your printer, pin the UUIDs once:

```ts
new BluetoothLETransport(device, { serviceUuid: '...', writeCharacteristicUuid: '...' });
```

You can keep these settings in a profile of your own. The package ships none:

```ts
const myPrinter: BlePrinterProfile = {
  name: 'my printer', protocol: 'BPLZ',
  matches: bleFilters.name('LP 46'),
  writeMode: 'withoutResponse', chunkDelayMs: 5,
};
const profile = BluetoothLE.matchProfile(device, [myPrinter]);
new BluetoothLETransport(device, { profile });   // explicit options still win over the profile
```

### Write type, piece size, flow control

- **Write type.** `writeMode: 'auto'` (default) uses "write with response" when the characteristic has it: the stack confirms each piece.
  Otherwise it uses "write without response". Set `'withResponse'` or `'withoutResponse'` to force one.
  Write without response is faster. The printer cannot say when its buffer is full, so the transport waits 10 ms between pieces by default (`chunkDelayMs`).
- **Piece size.** The transport asks the link for its limit before each job: Android = agreed MTU - 3 (at most 512 with response). iOS = `maximumWriteValueLength`.
  On Android the transport asks for MTU 247 after connect (`requestMtu`, `false` skips it). The device may agree to less. The transport uses what was agreed.
  `chunkSize` sets a lower limit. If the link reports nothing, 20 bytes are used (the smallest BLE packet).
- **Flow control.** One piece at a time. The next piece starts only after the stack accepts the last one:
  Android waits for `onCharacteristicWrite`. iOS waits for `didWriteValueFor` (with response) or for `canSendWriteWithoutResponse` / `peripheralIsReady` (without response).
  Two `write()` calls never mix their bytes.
- **Timeouts.** `writeTimeoutMs` (default 5000) is for one piece. `connectTimeoutMs` (default 10000) is for the connect.
- **Cancel.** `transport.cancel()` or `write(data, { signal })` stops between two pieces and rejects with `E_CANCELLED`.
  The printer may hold a part of the job. `LabelPrinter` closes the link after a failed job, so the next job starts clean.
- **Progress.** `write(data, { onProgress: (sent, total) => ... })`.

Bytes are never changed or turned into text. `Uint8Array` goes to the native side as `ArrayBuffer`.

### Connection life cycle

`transport.onConnectionState(fn)` gives `connecting`, `connected`, `disconnecting` and `disconnected` (with a `reason` such as `GATT status 8 (connection timeout)`).
If the printer goes out of range or switches off, the state changes at once and a running `write()` rejects with `E_DISCONNECTED`
(the message says how many bytes were sent). The next `LabelPrinter` job connects again. There is no background reconnect loop. `transport.reconnect()` does one reconnect when you call it.
`BluetoothLE.getState()` and `BluetoothLE.onStateChange()` show Bluetooth on, off, `unauthorized`, `unsupported`.

### Pairing (bonding)

The package does not store or send a PIN. If the printer needs an encrypted link, the operating system asks the user.
When a write fails for this reason the error code is `E_AUTH`. The user accepts the system dialog and prints again.
The Classic PIN of a printer does not apply to BLE.

### Error codes

| Code | Meaning | Retried by `LabelPrinter` |
| --- | --- | --- |
| `E_PERMISSION` | Permission not granted | no |
| `E_BLUETOOTH_OFF` | Bluetooth is off | no |
| `E_NO_ADAPTER` | No BLE on this device | no |
| `E_BAD_ADDRESS`, `E_BAD_UUID`, `E_DEVICE_NOT_FOUND` | Wrong id or UUID. On iOS: scan first. | no |
| `E_AUTH` | The device needs pairing | no |
| `E_NO_CHARACTERISTIC` | No usable write characteristic. The message lists the GATT table. | no |
| `E_CANCELLED` | You cancelled | no |
| `E_SCAN_FAILED` | The platform refused the scan (Android: no more than 5 starts in 30 s) | n/a |
| `E_CONNECT`, `E_DISCOVERY`, `E_TIMEOUT`, `E_WRITE`, `E_DISCONNECTED`, `E_NOT_CONNECTED` | Link problem | yes (a write is sent again only with `resendAfterPartialWrite`) |

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Scan finds nothing (Android 11 or older) | Location permission and the location switch of the phone. |
| Scan finds nothing (Android 12+) | `BLUETOOTH_SCAN` granted? Is the printer already connected to another phone or to Classic? Many BLE modules advertise to one central only. |
| `E_PERMISSION` on iOS | Settings > the app > Bluetooth. Is `NSBluetoothAlwaysUsageDescription` in Info.plist? |
| `E_CONNECT` with `GATT status 133` | A generic Android error. Switch Bluetooth off and on, move closer, make sure no other app holds the printer. A new attempt often works. |
| `E_NO_CHARACTERISTIC` | Read the table in the message. Pass `serviceUuid` and `writeCharacteristicUuid`, or `select`. |
| Labels print cut, or garbage after a big image | Use `writeMode: 'withResponse'`, or a larger `chunkDelayMs` (try 20), or a smaller `chunkSize`. |
| Slow big jobs | Use `writeMode: 'withoutResponse'` with a small `chunkDelayMs`, and keep the default MTU request. |
| iOS cannot find the device by the id from another phone | The iOS id is per phone. Scan again. |
| Printer prints once, then fails on the next job | The printer may hold one central at a time. `disconnect()` after the job, or keep one `LabelPrinter` for the whole session. |

## Tested hardware

One TVS LP 46 Dlite (SNBC BTP-4200E) was tested **by hand, outside this package**: Classic/SPP printing worked, nRF Connect connected over BLE,
the GATT table was found, and a BPLZ payload written by hand to the writable characteristic printed a label.
That is the source of the layout used in `__tests__/bluetoothLE.test.ts` ("serial-over-BLE module"): one service with a notify characteristic and a characteristic
that accepts both write types. The package code does not contain these UUIDs and does not need them.
**This package's own BLE code has not yet been run on that printer.** See the acceptance test below.

## Manual acceptance test (needs a phone and a printer)

Run it on one Android phone and one iPhone. Write down the result.

1. Install the example app or your own app. Turn the printer on. Close other apps that hold the printer.
2. `BluetoothLE.requestPermissions()` returns true.
3. `BluetoothLE.scan({ timeoutMs: 8000 })` shows the printer with a name and an RSSI.
4. `BluetoothLE.inspect(device)` prints a GATT table with a writable characteristic.
5. `new BluetoothLETransport(device)`: after `connect()`, check `transport.selection` (write and notify characteristic, `reason`, `alternatives`).
6. Print a small label (`ZplLabel` with text). It prints.
7. Print a big label: a 50 mm x 30 mm image from `ditherRgba` + `compressBitmap` (more than 20 KB of ZPL), then a label of the full width (108 mm). It prints without gaps or garbage.
   Repeat with `writeMode: 'withResponse'` and `'withoutResponse'`. Note the time of each.
8. `await printer.getStatus()` returns a status (BPLZ), or null when the printer does not answer. Note which.
9. Switch the printer off in the middle of a big job: the job rejects with `E_DISCONNECTED`, the transport reports `disconnected`. Switch it on and print again: it prints.
10. Turn Bluetooth off in the phone: the next print rejects with `E_BLUETOOTH_OFF` and is not retried.
11. Deny the permission: `E_PERMISSION`.
12. Android 12+ and Android 11 or older: both scan and print.

## What was and was not checked

See [REFERENCES.md](REFERENCES.md). In short: the TypeScript logic is unit-tested with a fake native layer. The Kotlin code compiles against the Android 14 API.
The Swift code is NOT compiled (no Swift toolchain in CI). Nothing ran on a device.
