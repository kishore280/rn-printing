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
- `BluetoothLETransport` is the only BLE transport. There is no dependency on a third-party BLE library.

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

#### iOS: the app in the background

Apple (Core Bluetooth Background Processing): an app with no Bluetooth background mode is suspended soon after it leaves the foreground.
It cannot use Bluetooth then, and it learns of a lost link only when it runs again. The package does not keep the app awake. The host app must:

1. Add `bluetooth-central` to `UIBackgroundModes` in Info.plist. With it, iOS keeps the link and wakes the app for Bluetooth events. The app still has only a short time in the background, so it must not rely on this for a long job.
2. Not let a job end half way. Read `printer.busy` (it is true while a job runs or waits). While it is true, ask iOS for more time with `UIApplication.beginBackgroundTask` (in a native module of the app) and end that task when `busy` is false again. Do not call `printer.release()` until then.
3. Know that a job can still be cut. If the link drops while bytes go out, `print()` rejects with `E_DISCONNECTED`, `nothingSent` false and `bytesSent` set. The outcome is unknown: part of the label may have printed. The package never sends that job again (only `resendAfterPartialWrite` allows it). Show the person the failure and let them print again.
4. State restoration (`CBCentralManagerOptionRestoreIdentifierKey`) is not used by this package. A link is opened again by the next job.

#### iOS: the device id can change

iOS gives each device an id that belongs to the phone. It can change when the printer uses a resolvable private address and the phone has forgotten it. Then `connect()` fails with `E_DEVICE_NOT_FOUND`.
Pass the scan result (not only its id) and `{ rediscover: true }` to `BluetoothLETransport`. The transport then scans once (4 s) with the saved services as filter, and connects to the one device that has the saved name. It refuses two matches. After the connect, `transport.id` is the id to save. It is off by default: two printers with one name in range would be mixed up. If the printer is not advertising (it is connected to another app), the scan finds nothing: the person must scan and choose again.

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

- **Write type** (`writeMode`):
  - `'auto'` (default): "write without response" when the characteristic has it, else "write with response".
    Write without response is the usual choice for serial-over-BLE printers. It can fit several packets in one connection event, so it is much faster.
  - `'write'`: "write with response". The stack confirms each piece. Slower (one piece per two connection intervals on iOS). The safest mode.
  - `'withoutResponse'`: force the fast mode. Connect fails with `E_NO_CHARACTERISTIC` when the characteristic cannot do it.
  The flag goes to the platform call: Android `WRITE_TYPE_NO_RESPONSE` / `WRITE_TYPE_DEFAULT`, iOS `.withoutResponse` / `.withResponse`.
  `selection.withResponse` shows what was chosen.
  Without response, the printer cannot say when its buffer is full. So on top of the stack's own flow control the transport waits `chunkDelayMs` between pieces
  (default 10 ms; `0` turns it off). If labels come out cut or with garbage, try `writeMode: 'write'`, or raise `chunkDelayMs`.
  The default of `'auto'` is a design choice that is NOT yet checked on the printer. Compare the modes on the real TVS (see the test plan).
- **Piece size.** The transport asks the link for its limit before each job: Android = agreed MTU - 3 (at most 512 with response). iOS = `maximumWriteValueLength`.
  On Android the transport asks for MTU 247 after connect (`requestMtu`, `false` skips it). The device may agree to less. The transport uses what was agreed.
  `chunkSize` sets a lower limit. If the link reports nothing, 20 bytes are used (the smallest BLE packet).
- **Flow control.** One piece at a time, in three layers. (1) TypeScript sends the next piece only after the last one finished, and two `write()` calls never mix (a queue).
  (2) Android runs one GATT operation at a time and waits for `onCharacteristicWrite` (Android keeps the link busy until then, also for writes without response;
  if a phone never calls back, the first probe notices and later pieces rely on Android's "busy" answer). (3) iOS waits for `didWriteValueFor` (with response)
  or for `canSendWriteWithoutResponse` and `peripheralIsReady(toSendWriteWithoutResponse:)` (without response). No timers or blind loops decide when a piece may go.
- **Pieces.** `chunkBytes()` splits the job into views of the input. Joined in order they equal the input, byte for byte. This is tested for 0 B to 100 KB at several link limits.
- **Timeouts.** `writeTimeoutMs` (default 5000) is for one piece. `connectTimeoutMs` (default 10000) is for the connect.
- **Cancel.** `transport.cancel()` or `write(data, { signal })` stops between two pieces and rejects with `E_CANCELLED`.
  The printer may hold a part of the job, so the transport closes the link (as it does after every failed write, timeout or lost link). The next job opens a clean link.
- **Progress.** `write(data, { onProgress: (sent, total) => ... })`.

Bytes are never changed or turned into text. `Uint8Array` goes to the native side as `ArrayBuffer`.

### Measure a link (`diagnostics()`)

`transport.diagnostics()` gives the numbers behind a link, for tests and logs: the write mode that was asked for and the one used (`withResponse`), the chosen characteristics,
the MTU and what the MTU request did (`asked 247, got 185`), the bytes per write (`payloadSize`), the wait between pieces, `noResponseCallback` (Android: did the first write without response get a callback:
`yes`, `no`, `unknown`; iOS: `not applicable`), the connect and discovery times, and `lastWrite` (bytes, chunks, payload size, delay, bytes accepted, time, error code and message).
The example app in the billing project has a "Printer test" screen that runs the hardware test list with these numbers.

### Connection life cycle

`transport.onConnectionState(fn)` gives the life cycle of the link and of each write:

```
connecting > connected > writing > connected   (write completed)
                      \> disconnected           (write failed, timed out, was cancelled, or the link was lost)
connected > disconnecting > disconnected         (you called disconnect)
```

`disconnected` has a `reason` (for example `GATT status 8 (connection timeout)`) and, when an error caused it, the `error` with its code. Each failure ends the link, so a failed job is never followed by the next job on the same link.
If the printer goes out of range or switches off, the state changes at once and a running `write()` rejects with `E_DISCONNECTED`
(the message says how many bytes were sent). The next `LabelPrinter` job connects again. There is no background reconnect loop. `transport.reconnect()` does one reconnect when you call it.
`BluetoothLE.getState()` and `BluetoothLE.onStateChange()` show Bluetooth on, off, `unauthorized`, `unsupported`.
When Bluetooth is off, ask for it with `await BluetoothLE.requestEnable()`: on Android it shows the system dialog "Turn on Bluetooth?" and resolves true or false (call `requestPermissions()` first). iOS has no such dialog for apps: it shows its own alert at the first use.

### Pairing (bonding)

The package does not store or send a PIN. If the printer needs an encrypted link, the operating system asks the user.
The Classic PIN of a printer does not apply to BLE.

- **Android, read from the AOSP source:** `BluetoothGatt` already repeats a read or write that fails with status 5 or 15, first with `AUTHENTICATION_NO_MITM`, then with `AUTHENTICATION_MITM`. That starts pairing by itself. The steps below run only when that did not work. A write without response gets no ATT error, so it cannot start pairing: the first write with response (or the notification setup at connect) does. Do not hold a Classic connection to the same printer while pairing over BLE: `createBond()` then pairs over Classic. If the phone says "paired" but the printer forgot the bond, the error tells the user to forget the device in the Bluetooth settings and connect again.
- **Android:** when an operation fails because the printer wants pairing (GATT status 5, 15 or 137), the package starts the bond itself (`createBond()`), waits for the result, and repeats the operation once. It does this once per connection. If the user says no, you get `E_AUTH` ("The device was not paired…"). That error is not retried. Options of `BluetoothLETransport`: `bond: 'auto' | 'never'` (default `'auto'`) and `bondTimeoutMs` (default 30000). `diagnostics().bondState` shows `none`, `bonding` or `bonded`.
- **iOS:** there is no pairing API. iOS pairs by itself at the first operation that needs it, and shows its own dialog. `bondState` is always `unknown`. A failure is `E_AUTH` too.
- Not tested on the TVS LP 46 Dlite. It may not need pairing at all.

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
| `E_SCAN_FAILED` | The platform refused the scan | n/a |
| `E_SCAN_THROTTLED` | Android: more than 5 scan starts in 30 s. Wait 30 s | n/a (a wait helps; the screen decides) |
| `E_LOCATION_OFF` | Android 11 and older: the location switch is off, so a scan finds nothing | n/a (the user must fix it) |
| `E_CONNECT`, `E_DISCOVERY`, `E_TIMEOUT`, `E_WRITE`, `E_DISCONNECTED`, `E_NOT_CONNECTED` | Link problem | yes (a write is sent again only with `resendAfterPartialWrite`) |

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Scan finds nothing (Android 11 or older) | Location permission and the location switch of the phone. |
| Scan finds nothing (Android 12+) | `BLUETOOTH_SCAN` granted? Is the printer already connected to another phone or to Classic? Many BLE modules advertise to one central only. |
| `E_PERMISSION` on iOS | Settings > the app > Bluetooth. Is `NSBluetoothAlwaysUsageDescription` in Info.plist? |
| `E_CONNECT` with `GATT status 133` | A generic Android error. Switch Bluetooth off and on, move closer, make sure no other app holds the printer. A new attempt often works. |
| `E_NO_CHARACTERISTIC` | Read the table in the message. Pass `serviceUuid` and `writeCharacteristicUuid`, or `select`. |
| Labels print cut, or garbage after a big image | Use `writeMode: 'write'`, or a larger `chunkDelayMs` (try 20), or a smaller `chunkSize`. |
| Slow big jobs | Use `writeMode: 'withoutResponse'` with a small `chunkDelayMs`, and keep the default MTU request. |
| iOS cannot find the device by the id from another phone | The iOS id is per phone. Scan again. |
| `E_AUTH` "closed the link after a failed pairing", or a pairing dialog that opens again and again | The device asks for pairing as soon as the link opens, the pairing fails, and the device closes the link (GATT status 19). Forget the device in the phone's Bluetooth settings (also its Classic entry) and try once. If it still fails, the device has its own Bluetooth password setting: turn it off with the maker's tool. See `docs/BLE-HARDENING.md` section 11. |
| Printer prints once, then fails on the next job | The printer may hold one central at a time. `disconnect()` after the job, or keep one `LabelPrinter` for the whole session. |

## Tested hardware

One TVS LP 46 Dlite (SNBC BTP-4200E) was tested **by hand, outside this package**: Classic/SPP printing worked, nRF Connect connected over BLE,
the GATT table was found, and a BPLZ payload written by hand to the writable characteristic printed a label.
That is the source of the layout used in `__tests__/bluetoothLE.test.ts` ("serial-over-BLE module"): one service with a notify characteristic and a characteristic
that accepts both write types. The package code does not contain these UUIDs and does not need them.
**This package's own BLE code has not yet been run on that printer.** See the acceptance test below.

## Manual acceptance test (needs a phone and a printer)

Run it on one Android phone and one iPhone. Write down the result.

0. The example `example/BleHardwareTest.tsx` runs this plan: scan, connect (it logs the GATT table, the chosen characteristics and the piece size), then buttons A to G, with a write-mode switch and a delay box.
   The payloads are in `example/hardwarePayloads.ts` (BPLZ only, no BLE inside): A `HELLO FROM BLE`, B text and positions, C QR, D Code 128, E image/logo, F large image (a picture and a noise label of 100 KB or more), G ten labels in a row.
   They follow the media size and the dots per mm you pass in (`labelWidthMm`, `labelLengthMm`, `dotsPerMm`). The defaults are 50 x 30 mm and 8 dots/mm (203 dpi). The large test defaults to 100 x 100 mm.
1. Install the example app or your own app. Turn the printer on. Close other apps that hold the printer.
2. `BluetoothLE.requestPermissions()` returns true.
3. `BluetoothLE.scan({ timeoutMs: 8000 })` shows the printer with a name and an RSSI.
4. `BluetoothLE.inspect(device)` prints a GATT table with a writable characteristic.
5. `new BluetoothLETransport(device)`: after `connect()`, check `transport.selection` (write and notify characteristic, `reason`, `alternatives`).
6. Print a small label (`ZplLabel` with text). It prints.
7. Run E, then F (picture, then noise), then G. They print without gaps, shifted rows or garbage.
   Repeat with `writeMode: 'write'` and `'withoutResponse'`, and with `chunkDelayMs` 0, 10 and 30. Note the time and the bytes per second of each. Write down the fastest setting that prints correctly.
8. `await printer.getStatus()` returns a status (BPLZ), or null when the printer does not answer. Note which.
9. Switch the printer off in the middle of a big job: the job rejects with `E_DISCONNECTED`, the transport reports `disconnected`. Switch it on and print again: it prints.
10. Turn Bluetooth off in the phone: the next print rejects with `E_BLUETOOTH_OFF` and is not retried.
11. Deny the permission: `E_PERMISSION`.
12. Android 12+ and Android 11 or older: both scan and print.

## What was and was not checked

See [REFERENCES.md](REFERENCES.md). In short: the TypeScript logic is unit-tested with a fake native layer. The Kotlin code compiles against the Android 14 API.
The Swift code compiles in CI (job `ios`, Simulator SDK). Nothing ran on a device.
