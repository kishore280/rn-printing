# References and how each part was checked

Nothing here is tested on a real SNBC printer yet. This page lists what each part was checked against,
so you know how far to trust it.

## Checked against an outside reference

| Part | Reference | Result |
| --- | --- | --- |
| ZPL ASCII compression (`G`–`Y`, `g`–`z`, `,` `!` `:`) | [Zebra ZPL guide: alternative compression](https://docs.zebra.com/us/en/printers/software/zpl-pg/advanced-techniques/alternative-data-compression-scheme-for-~dg-and-~db-commands.html); [`zpl-image-ts`](https://www.npmjs.com/package/zpl-image-ts) (port of metafloor/zpl-image) | Rules match the Zebra text and its examples (`M6`, `hB`, `vMB` = 327). |
| Same, rendered | [Labelary](https://labelary.com/) (a ZPL renderer) | Our C++ output renders pixel-exact (0 wrong pixels) for random, sparse, repeated-row and half-filled bitmaps, and matches the plain-hex render. |
| `^GF` syntax | [Zebra `^GF`](https://docs.zebra.com/us/en/printers/software/zpl-pg/c-zpl-zpl-commands/r-zpl-gf.html) | Parameters and byte counts as documented. |
| Bayer 8×8 matrix | Wikipedia recursive definition `M(2n) = [[4M, 4M+2],[4M+3, 4M+1]]` | Identical. |
| Threshold dither | Pillow `convert('1', dither=NONE)` | 100 % identical. |
| Floyd–Steinberg, Atkinson | Pillow / ImageMagick | Same overall darkness (0.51 vs 0.50). Pixel patterns differ from Pillow and ImageMagick (about 60–68 % equal), as expected for different scan and rounding choices. |
| Grey weights 77/150/29 (÷256) | ITU-R BT.601 luma (0.299, 0.587, 0.114) | Same weights, in integers. |
| Base64 | RFC 4648, Node `Buffer` | Identical for 0–300 byte inputs and for 100 KB. |
| `ArrayBuffer`, Promise, HybridObject use | [Nitro docs](https://nitro.margelo.com/docs/types/array-buffers), Margelo `build-nitro-modules` skill, official `nitrogen init` scaffold | Build files come from the scaffold. Specs pass `nitrogen`. |
| iOS limit | [Apple developer forums](https://developer.apple.com/forums/thread/72148) | Bluetooth Classic (SPP) needs MFi. Public CoreBluetooth is BLE only. |
| ZPL barcode and `^BQ` parameters | Zebra ZPL II programming guide | Parameter order as documented. |
| ZPL parser and checker (`src/zplParse.ts`) | Command list and value ranges from the SNBC SDK V2.4.2.1 C API guide and native library (`docs/TEARDOWN.md` 4a); syntax from the Zebra ZPL II guide | Tested against our own builder output and against the reference compressor (round trip). **NOT checked on a printer.** SNBC publishes no BPLZ command manual, so "no issue" does not mean the printer accepts the label. Default font (`^CF` A, 9 x 5) and QR default cell size 1 are from memory of the Zebra guide, not verified. |
| Limits and settings from the Zebra guide (`zplSettings`, `checkDesign`, `parseZpl`) | Zebra ZPL II Programming Guide 2008: `^GF` 1 to 99999 bytes; `^A` scalable size 10 to 32000; `~SD` 00 to 30; `^MD` -30 to 30; `~TA` -120 to 120; `^PR` speeds; quiet zone of about 10 narrow bars; scalable font "height and width equally ... most balanced" (p. 898) | Checked by unit tests only. NOT checked on the SNBC printer: its firmware may differ. Font 0 ratio: see test label T17. |
| Read-only printer questions (`src/probe.ts`: `PROBES`, `parseConfigReport`, `settingsFromConfig`, `LabelPrinter.ask`) | Zebra ZPL II guide: `^HH` (configuration to the host), `~HI`, `~HS`, `~HM`, `~HQ` types OD, PH, JT, SN, MA; Zebra's configuration report labels (DARKNESS, PRINT SPEED, PRINT MODE, MEDIA TYPE, PRINT METHOD, LABEL LENGTH); the SNBC SDK strings `~WN01@version~`, `~WN00@ini,r,...` | The parser is tested against a report built from the settings of the owner's self-test print. **What the SNBC printer answers to each question is NOT known**: the Printer page's "What the printer says" is how to find out. A silent printer is shown as silent. No question prints, writes or changes anything (a test checks the command text). |
| Font 0 shape (`FONT0_RATIO` = 1 in `src/design.ts`) | Zebra ZPL II guide: font 0 default matrix 15 x 12 ("Font Matrices"), and p. 898: equal height and width looks "most balanced" for scalable fonts | We use equal values, as our first hardware labels did. NOT settled on the SNBC printer: test label T17 compares 0.6, 0.8, 1.0 and 1.2. |
| BPLA text record layout | Datamax DPL record table (rotation, font, width mult, height mult, size, row, column) and the format strings inside SNBC's own library | Same layout. |
| BPLC (CPCL) | Zebra and Brother CPCL manuals; command strings inside SNBC's library | Same commands. |

## BLE (native `BluetoothLE` and `BluetoothLETransport`)

Sources for the platform calls (official docs; the pages were not fetched again during this change, so check them when you change the code):
- Android: `BluetoothLeScanner`, `ScanSettings`, `ScanFilter`, `BluetoothGatt` (`connectGatt`, `discoverServices`, `requestMtu`, `writeCharacteristic`, `writeDescriptor`, `requestConnectionPriority`), `BluetoothGattCallback`,
  [Bluetooth permissions](https://developer.android.com/develop/connectivity/bluetooth/bt-permissions) (`BLUETOOTH_SCAN` with `neverForLocation`, `BLUETOOTH_CONNECT`, location up to Android 11).
- Android rule used for flow control: one GATT operation at a time; wait for `onCharacteristicWrite` before the next write.
- iOS: `CBCentralManager` (`scanForPeripherals`, `connect`, `retrievePeripherals(withIdentifiers:)`), `CBPeripheral` (`maximumWriteValueLength(for:)`, `canSendWriteWithoutResponse`,
  `peripheralIsReady(toSendWriteWithoutResponse:)`, `writeValue(_:for:type:)`, `setNotifyValue`), `CBATTError`, `CBError.peerRemovedPairingInformation`.
- The Nitro Swift and Kotlin API (`Promise`, `ArrayBuffer`) was read in `node_modules/react-native-nitro-modules`.
- Read for the review round (engineers' write-ups, not official docs; none was run by us):
  - Android keeps `BluetoothGatt` busy for every write, also without response, until `onCharacteristicWrite`; a write sent before it gets `ERROR_GATT_WRITE_REQUEST_BUSY (201)`; completing a no-response write early drops failures:
    [blew PR 53](https://github.com/mcginty/blew/pull/53), [android-ble-rs issue 3](https://github.com/uglyoldbob/android-ble-rs/issues/3), [Making Android BLE work, part 3 (M. van Welie)](https://medium.com/@martijn.van.welie/making-android-ble-work-part-3-117d3a8aee23), [Punch Through Android BLE guide](https://punchthrough.com/android-ble-guide/).
    Used for: wait for the callback; retry a refused write; one operation at a time; a probe in case a phone does not call back.
  - iOS: wait for the callback between writes with response (Apple engineer in [Apple forums 800026](https://developer.apple.com/forums/thread/800026)); for writes without response use `canSendWriteWithoutResponse` and `peripheralIsReady(toSendWriteWithoutResponse:)`
    ([Apple: canSendWriteWithoutResponse](https://developer.apple.com/documentation/corebluetooth/cbperipheral/cansendwritewithoutresponse)). Used for: `BleCentral`/`HybridBleConnection` pump.
  - Usable payload = MTU - 3; request the MTU before service discovery on Android; write without response fits several packets per connection event; `CONNECTION_PRIORITY_HIGH` for bulk data:
    [Reliable BLE data transfer (U. Nguyen)](https://uynguyen.github.io/2026/04/12/Reliable-BLE-Data-Transfer-MTU-Throughput-Chunking/), [A Practical Guide to BLE Throughput (Memfault Interrupt)](https://interrupt.memfault.com/blog/ble-throughput-primer).
    Not done: the connection priority is not set back to balanced after a job (the link closes anyway).
  - Large label jobs on BLE printers: chunk to the MTU with a short delay so the printer buffer does not overflow ([flutter_print_label](https://pub.dev/packages/flutter_print_label)); very tall images can fail on small printer buffers, so split very long jobs.
  - Reading reference stacks for low-level behavior: trace one path (here: one write) instead of reading a file top to bottom ([LKML thread on learning kernel code](https://lkml.iu.edu/hypermail/linux/kernel/9801.2/0972.html)); BlueZ [`src/shared/gatt-client.h`](https://coral.googlesource.com/bluez-imx/+/refs/tags/5.27/src/shared/gatt-client.h) and the Zephyr [Central GATT Write sample](https://docs.zephyrproject.org/latest/samples/bluetooth/central_gatt_write/README.html) show the same write-without-response pending-limit idea.
- Android late callbacks: `GattOpGuard` (android/.../GattOpGuard.kt) gives each GATT operation a token, drops the callback of a timed-out or cancelled operation, and closes on disconnect. Race-tested on a JVM (`test-native/GattOpGuardTest.kt`, run by `scripts/check-kotlin.sh`). Not run on a device. The first write without response is a probe: if it times out, its callback is dropped when it comes (for 2 s), and an operation that needs a callback waits for that window, so a late probe callback cannot complete it. Limit: a callback has no id, so the guard relies on Android answering in order, one operation at a time. Later writes without response (after the probe) are not tracked, because nothing waits for them.
- Bluetooth SIG: 16-bit UUIDs 1800, 1801, 180A (Generic Access, Generic Attribute, Device Information) and the Bluetooth base UUID `0000xxxx-0000-1000-8000-00805f9b34fb`.

Status:
- TypeScript logic (scan mapping, GATT selection, MTU and piece size, chunking, flow control, timeouts, cancel, link loss, reconnect through `LabelPrinter`, error codes) is unit-tested with a fake native layer: `__tests__/bluetoothLE.test.ts`.
- Kotlin (`HybridBluetoothLE`, `HybridBleConnection`) compiles with `kotlinc` against the Android 14 API (`scripts/check-kotlin.sh`). Not run on a device.
- Swift (`ios/*.swift`) was written against the generated Nitro Swift specs. It is NOT compiled: there is no Swift toolchain in this environment or in CI.
- The selection rule (score +4 / +2 / +1) and the defaults (MTU request 247, 10 ms delay for writes without response, 5 s write timeout, 10 s connect timeout, 15 s discovery timeout) are our choices. They are not from a source and not tuned on a printer.
- A user reported (manual test with nRF Connect and a hand-written BPLZ payload, not run by this package) that one TVS LP 46 Dlite prints over BLE. That is the only hardware evidence.
- Android: the code expects `onCharacteristicWrite` for "write without response" (reported by the sources above) and has a probe in case a phone does not. Not checked on a device.

## Hardware facts: the printer self-test of one TVS LP 46 Dlite

Source: a photo of the printer's own self-test print, sent by the owner on 2026-10-06. Test data, not code: none of it is built into the package.

| Item | Value on the print |
| --- | --- |
| Model, firmware | TVSE LP 46 Dlite, main firmware FV1.050 |
| Command language | **BPLZ** (confirms the language; the open item "find the COMMAND line" is closed) |
| Resolution, print width | `864 FULL`; print width 864 dots = 108 mm at 8 dots/mm = **203 dpi** |
| Label length (calibrated) | 561 dots = about 70 mm. Maximum length 43 in / 1100 mm |
| Media, method | GAP/NOTCH media, WEB sensor (manual select), thermal transfer, tear-off, darkness 15, 5.1 IPS |
| Serial port | 115200 baud, 8 bits, no parity, host handshake DTR/DSR |
| Bluetooth | name `TVSE LP 46 Dlite_4152`, address 28:D4:1E:5B:75:D3, Bluetooth version `B_KR_250210_r4686` |
| Network | IP 0.0.0.0, raw port 9100 set, but this unit has no network port in use |

What follows from it:
- The default label of the billing app (50 x 30 mm) is not this media: set the real width and a height of about 70 mm, or the print is cut or off the label.
- An earlier note here guessed that a 115200-baud serial line limits the Bluetooth speed to about 11 KB/s. **The first hardware run disproved it**: 120 KB went through in 8.4 s (14.4 KB/s) and printed right.

## First hardware run (2026-10-06, Android 16, auto mode, MTU 247, billing app Printer test)

Measured by the owner with the Printer test screen (their report and photos). Mode `auto` used write without response; one mode so far.

| Test | Result |
| --- | --- |
| Scan, GATT discovery, selection | OK. The printer was found at -50 dBm. The write characteristic chosen was `...6daa...` (3 equal scores, the first one found). It printed, but it is also readable, so it looks like a setting; `...8841...` is the usual data input. The selection rule now prefers a characteristic that cannot be read. |
| MTU | asked 247, got 247, payload 244 B |
| Probe | `onCharacteristicWrite` was called for write without response (`probe callback: yes`), as the Android sources said |
| Small label, QR, barcode, image (10 KB, 716 ms), large image (120,627 B, 495 chunks, 8.4 s, 14.4 KB/s) | OK, and the labels printed right (photos) |
| 10 labels in a row | The app sent all 10 in 53 ms (107 B each) and said OK. The printer printed only 2 and then showed a red light. **The cause is not known.** The owner suspects the roll ran out after 2 labels (the printer stops with a media-out error and keeps the rest in its memory). That fits better than data loss: 1 KB is small, and 120 KB went through without loss in test 9. To settle it: load a new roll and press feed WITHOUT clearing the printer memory. If labels 3 to 10 then print, the data was never lost. Until then this result counts as "not valid", not as a failure of the transport. |

## nRF Connect log of the same unit (2026-10-06, Android)

Facts from the log. The UUIDs are examples from ONE unit. No code may build them in.

| Item | What the log shows |
| --- | --- |
| Device information | Manufacturer `BARROT`, model `BR8051A01`, serial = the Bluetooth address, firmware, hardware and software `1.00`. So the Bluetooth part is a third-party module, not SNBC's own. |
| Services | Seven. `49535343-fe7d...` (the Microchip-style transparent UART: data in `...8841...` [W, WNR], data out `...1e4d...` [N]; Microchip documents these two roles). Also `...6daa...` [R W WNR] and `...aca3...` [N W] in the same service (not documented in what we found; reading `6daa` gives 0 bytes). Also `0000ff10` (ff11, ff12 [N WNR]), `0000eee0` (eee1 [N W]), `0000eee2` (eee3 [N W]), `0000fee7` (fec7 [W], fec8 [I], fec9 [R]), `0000ff00` (ff02 [W WNR], ff01 [N], ff03 [N]). |
| What this means | The module has several UART-like paths. Two of them look like a data in / data out pair: the `49535343` service and the `0000ff00` service. We do not know if they reach the same printer UART. Only the `49535343` one is checked: the app printed through it. |
| Pairing | `createBond()` gives the pairing variant CONSENT (just works, no PIN). The first try was removed by the system after 4 s (bond state NONE, reason REMOVED). The second try bonded in about 5 s (encryption AES, bond state BONDED). So the printer pairs without a PIN, but the user must accept the system dialog quickly. |
| Idle drop | The first link ended 7.5 minutes after connect with `GATT CONN TIMEOUT` (status 8, the supervision timeout of 5 s). The unit stops answering after some idle time. This fits our design: reconnect when a job starts, no background loop. |
| Link parameters | The interval changed between 7.5 ms, 30 ms and 11.25 ms after the connect. The supervision timeout stayed at 5 s. |
| MTU | No MTU request in this log. Without one the limit is 20 bytes per write. |

## Theory notes (read, not run; written 2026-10-06 while no printer was at hand)

Sources: web search results of Microchip's developer help and Zebra's guides (the pages themselves refused direct fetches: HTTP 406 and 503), so each point is a summary, not a quote.

- **The Bluetooth chip is a Microchip BM70 / RN4870 style module.** Service `49535343-FE7D-4AE5-8FA9-9FAFD205E455` is the Microchip *Transparent UART* service:
  RX `49535343-8841-43F4-A8D4-ECBE34729BB3` (write, write without response) takes the data; TX `49535343-1E4D-4BD9-BA61-23C647249616` (notify) sends data back
  ([Transparent UART service for BM70/RN4870](https://developerhelp.microchip.com/xwiki/bin/view/applications/ble/android-development-for-bm70rn4870/transparent-uart-service-for-bm70rn4870/)).
  The characteristics `49535343-6daa-...` (read, write, write without response) and `49535343-aca3-...` (write, notify) of the same service are NOT in Microchip's documentation (they look like legacy ISSC extras).
  The run on 2026-10-06 used `6daa` and printed; the data input in the documentation is `8841`. The selection rule now prefers a characteristic that cannot be read, which picks `8841`.
  (The rule has no UUID. The UUIDs are written here only to explain one observed table.)
- **Flow control.** Microchip says that when the Transparent UART streams data, the host should use the RTS/CTS lines with hardware flow control on, because without it the host can overflow the module's UART buffer
  ([Hardware Flow Control](https://onlinedocs.microchip.com/oxy/GUID-1B991CE9-4FE3-48B8-BC90-28F5F29AD994-en-US-1/GUID-944493A1-7DFF-49C0-B571-DF26D971A2E0.html)).
  Whether this printer wires RTS/CTS between the module and its board is unknown. The run showed no loss at 14.4 KB/s (120 KB), so the margin is not known; the delay test (0, 10, 20, 30 ms) measures it.
  Write without response has no acknowledgement from the module, so a bigger delay or `writeMode: 'write'` is the way to slow down.
- **Out of media.** Zebra's printers show a red status light for a media-out condition (the label roll is empty or the sensor cannot find the label); you load labels, close the printer and press Feed to resume
  ([detecting a media-out condition](https://docs.zebra.com/us/en/printers/desktop/zd888da-zd230da/detecting-a-media-out-condition.html)).
  This fits the red light after "2 of 10 labels". The ZPL buffer is cleared by `~JA` and `~JR` (Zebra ZPL II guide, via search results).
- **Size from the printer.** `~HI` returns model, firmware, dots per millimetre and memory; `~HS` returns the label length in dots. Neither gives the print WIDTH
  (this printer's self-test shows 864 dots; no standard ZPL query gives it). Both are Zebra commands; an SNBC printer may answer in another shape or not at all.
- **What the app's test screen does with it.** Before each print test it asks the printer for its status and does not start when the printer reports a problem. A second after the test it asks again and writes both answers into the report, so "the phone sent it" can be told from "the printer printed it".

## Real replies of the owner's TVSE LP 46 Dlite (2026-10-09)

Copied from the app's "What the printer says" page (firmware V56.17.9Z, `~WN01@version~` says FV1.050.00). Tests: `__tests__/probe.test.ts` and `__tests__/status.test.ts`, "real replies".

- `~HI` answers `TVSE LP 46 Dlite-200dpi,V56.17.9Z,8,8172KB`: the third field is 8 dots per mm (203 dpi).
- `~HS`, `~HQES`, `~HM`, `~HQOD`, `~HQPH`, `~HQJT`, `~HQSN`, `~HQMA`, `^HH` and the two `~WN` reads all answer. The parsers read `~HS`, `~HQES`, `~HI`, `~HM` and `^HH` correctly. The ready printer gives no error and no warning.
- `^HH` shows PRINT WIDTH 856 and LABEL LENGTH 178 here, and `~HS` shows `0178`. The first self-test showed 864 and 561. So these two are settings that a job changed (our `^PW` and `^LL`), not facts of the printer. Do not use them as the paper size.
- The Bluetooth table has a transparent serial service (`49535343-…`, write and notify) and more services (`0xFF00`, `0xFF10`). No UUID is built into `src/`; the package chooses at run time.
- Not seen: a reply with a fault (paper out, head open, paused).

## Compiled, not run

- **C++:** `HybridBplzCodec` and the core compile against the real Nitro and JSI headers (`g++ -std=c++20 -fsyntax-only`).
  The core is also built and run on the host, and compared with the TypeScript reference on random data
  (`__tests__/native-parity.test.ts`).
- **Kotlin:** `HybridClassicBluetooth`, `HybridClassicConnection`, `HybridBluetoothLE` and `HybridBleConnection` compile with `kotlinc` 2.1.21 against the Android 14
  API jar, the real Nitro Kotlin sources and the real `react-android` 0.87.1 classes. Only two annotations were stubbed.

## Not checked

- Anything on a real device or a real SNBC printer.
- The Android and iOS native builds (Gradle, CMake, Xcode). The build files come from the official scaffold.
- The BPLA row and column units, and the `Q`, `E`, `<STX>L` framing.
- The meaning of the `~HS` and `~HQES` fields when the printer has a fault. Only the "ready" replies were seen (see "Real replies").
- BLE on a real phone and printer (Android and iOS), with this package's own code. See the manual test in [BLE.md](BLE.md).
- The Swift code: it was never compiled.
- Speed on Hermes or on a phone CPU. `npm run bench` measures Node (V8) only.

## Reconnect design

Sources read:
- ble-plx ConnectionManager (@sfourdrinier fork) docs: attempts include the first try; exponential backoff (1000 ms start, x2, cap 30000 ms); events connecting / connected / disconnected / failed.
- bleak-retry-connector usage guide: default 4 attempts; do not retry when the device is not found; do not multiply timeouts.
- Zebra Link-OS `ConnectionReestablisher`: the SDK has a hook to re-open a link that closed (for example after a reboot).
- Qt forum thread on Bluetooth print failing halfway: do not close the link before all bytes are flushed.

Status: logic is tested with a fake transport (`__tests__/reconnect.test.ts`). NOT tested with a real printer. Our delay values (300 ms, x2, cap 2000 ms) are our choice, not from a source: a label printer needs a shorter wait than a sensor app.

Decision: ONE retry layer, built on `cockatiel` 3.2.1 (MIT, CJS+ESM, Node >= 16; a TypeScript port of Polly). It supplies RetryPolicy, ExponentialBackoff and decorrelated jitter (see the AWS backoff-and-jitter article and Polly issue 530, cited in cockatiel's source).
The ble-plx fork ConnectionManager was read and tried, then removed: it only works for BLE, only in a fork, and made two retry layers in one package.
Checked: retry behavior with a fake transport and fake timers. NOT checked: on a real printer or on Hermes (cockatiel uses setTimeout and AbortSignal; both exist in React Native, not run here).
Our own parts: which errors are transient, the error-code mapping from Kotlin messages, the no-resend rule, the default delay values.

| BLE `read` and `readGatt()` | Pattern: nRF Connect and other generic GATT clients (discover, read each characteristic with the read property). Android: `BluetoothGatt.readCharacteristic` with `onCharacteristicRead` (two overloads, Android 13 split). iOS: `CBPeripheral.readValue(for:)` and `didUpdateValueFor`. SIG names and decoders: Bluetooth SIG Assigned Numbers, GATT Specification Supplement (short list in `src/transports/sig.ts`). Unit-tested with a fake link. Kotlin compiled, Swift NOT compiled. NOT run on the printer. |
