# AGENTS.md

Read this file before you change the code. It tells you where things are, how they work, and what rules to keep.

## What this package is

`react-native-bplz-label-printer` prints labels from React Native to SNBC-family label printers
(TVS LP 46 D Lite = SNBC BTP-4200E; 203 dpi; 108 mm maximum width).

- Command languages: BPLZ (ZPL II), BPLC (CPCL), BPLA (experimental).
- Transports: Bluetooth Classic (Android only), BLE (Android + iOS, native), TCP port 9100 (Android + iOS).
- iOS has NO Bluetooth Classic. Apple allows it only with MFi hardware. iOS uses BLE or TCP.
- Built on Nitro Modules (`react-native-nitro-modules`). Fast native code. No bridge JSON.

## Design rules (do not break)

1. **No JavaScript fallback for native code.** The C++ codec is the only implementation of
   dither, ZPL compression and base64. If the native module is missing, throw `NativeModuleMissingError`.
2. **`test/reference/` is an oracle only.** It is the slow TypeScript copy that tests compare against.
   Never import it from `src/`. Never ship it.
3. **Never edit `nitrogen/generated/` by hand.** Change a spec, then run `npx nitrogen`. Commit the result.
   CI fails if the generated files are stale.
4. **Specs live in `src/specs/`.** One Kotlin type per file. Keep spec types simple.
5. **Do not hand-roll protocol details.** Use a source: the Zebra ZPL II guide, the SNBC SDK
   (see `docs/TEARDOWN.md`), Labelary, or the Nitro docs. Write the source in `docs/REFERENCES.md`.
6. **Do not claim unverified behavior.** If you did not test it on a printer, say so in the doc
   comment and in `docs/REFERENCES.md`.
7. Keep TypeScript strict. No `any` without a comment that says why.

## Review rules (the kernel's coding style, measured)

`__tests__/linus.test.ts` fails when `src/` breaks one of these. There is no allow-list: split the code, do not raise a limit.
They come from Linux `Documentation/process/coding-style.rst`.

- A function is at most 60 lines and does ONE thing (chapter 6).
- A function nests at most 3 levels of `if` / `for` / `while` / `try` / `switch` (chapter 1: "if you need more than 3 levels of indentation, you're screwed anyway"). Use early returns and small named helpers.
- A file is at most 500 lines and has one reason to change. Split by reason, not by size alone.
- No `any`, no `@ts-ignore`, no `@ts-nocheck`. A cast has a comment that says why.
- A comment says WHAT and WHY, never HOW. Do not comment bad code: rewrite it (chapter 8).
- Do not hide state behind a helper that does nothing (chapter 12: "do not use opaque accessors"). Do not add an option nobody uses.
- Do not break what a caller sees. A change to the public API of a released tag needs a version bump and a note.

## Layout

| Path | What is there |
| --- | --- |
| `src/index.ts` | Public exports. Add new public API here. |
| `src/zpl.ts` | `ZplLabel` builder (BPLZ), `zplSettings`, `zplDownloadImage`, `testLabel`. |
| `src/zplParse.ts`, `zplTokens.ts`, `zplTypes.ts` | `parseZpl`, `validateZpl`, `decodeGfaData`: reads ZPL text into drawable elements and issues. Pure TS. Used for previews. Not checked on a printer. `zplTypes` = result types, `zplTokens` = text to commands and the stateless checks, `zplParse` = the printer state and one method for each command. |
| `src/design.ts` | `LabelDesign` (items in mm), `designToZpl`, `checkDesign`, FSSAI veg symbol. The ZPL always comes from the design, never typed by the user. Not checked on a printer. |
| `src/probe.ts` | `PROBES` (read-only questions to a connected printer), parsers for the configuration report (`^HH`), `~HM` and key-value replies, `settingsFromConfig`. `LabelPrinter.ask(command)` sends one and returns the text. Nothing in it writes. Not checked on the SNBC printer. |
| `src/receipt.ts` | Receipts (ESC/POS). `ReceiptDesign` (blocks: text, row, rule, feed, table, qr, barcode, cut), `layoutReceipt` (the lines as they print: the preview), `receiptToBytes` (bytes from the same lines, made by `@point-of-sale/receipt-printer-encoder` 4.0.1), `checkReceipt`. Pure TS. Paper is 16 to 48 columns. `ensureStructuredClone` is the Hermes guard. It is split in `receiptTypes.ts` (types), `receiptText.ts` (code pages, what can print, wrap and align), `receiptLayout.ts` (one function for each block kind) and `receipt.ts` (the public API and the bytes). Send the bytes with `LabelPrinter.printRaw`. Not checked on a printer. See `docs/RECEIPT.md`. |
| `src/cpcl.ts` | `CpclLabel` builder (BPLC), `cpclSettings`. |
| `src/bpla.ts` | `BplaLabel` builder. Experimental. Origin is bottom-left. |
| `src/image.ts` | `ditherRgba`, `ditherGray`, `compressBitmap`. Call native code. Async. |
| `src/bitmap.ts` | Types: `Bitmap1bpp`, `DitherMethod`, `DitherOptions`. |
| `src/printer.ts` | `LabelPrinter`: queue (mutex), `print`, `printRaw` (bytes), `printAll`, status. |
| `src/reconnect.ts` | cockatiel retry policy, transient-error rule, `ReconnectOptions`, `ConnectionEvent`. Used by `LabelPrinter`. |
| `src/status.ts` | Parsers for `~HS` and `~HQES` replies. |
| `src/transport.ts` | `Transport` interface, `LinkState`, `LinkEvent`, `WriteOptions`. The link events, `cancel` and `endJob` are optional on a transport. |
| `src/linkHealth.ts` | Pure rules: is the link really lost? `up` / `wobbling` / `lost` / `unknown`. Up is never delayed; down waits 4 s or two hard failures. `LabelPrinter.health` runs it. Numbers are NOT measured on the printer. |
| `src/errorCodes.ts` | The one table of error codes (transient, before any byte, user must fix). `__tests__/errorCodes.test.ts` fails when Kotlin, Swift or TS use a code that is not in it. |
| `src/transports/` | `tcp.ts` (one job = one connection: `endJob()` closes it; pieces with progress and cancel, a time limit for each piece, `TCP_NODELAY`, link events; tested with a fake socket and with real sockets, not with `react-native-tcp-socket` on a phone), `bluetoothClassic.ts` (Nitro), `bluetoothLE.ts` (`BluetoothLETransport`, Nitro; `readGatt()` reads every readable characteristic; it re-exports the next three files, so the public path is unchanged), `bleScan.ts` (`BluetoothLE` scan/connect, `bleFilters`), `bleTypes.ts` (the public types), `bleCommon.ts` (error mapping and the native object), `bleRediscover.ts` (find an iOS device again when its id changed; option `rediscover`), `sig.ts` (Bluetooth SIG names and decoders for 16-bit UUIDs only), `bleGatt.ts` (pure GATT selection), `chunk.ts` (pure splitting), `tcp.ts`, `inbox.ts`. |
| `src/native.ts` | Lazy loading of Nitro objects. `setNativeCodec` / `setClassicBluetooth` for tests. |
| `src/encoding.ts` | base64, UTF-8, Latin-1 helpers. |
| `src/errors.ts` | Error classes. |
| `src/specs/*.nitro.ts` | Nitro specs. The source of truth for native APIs. |
| `cpp/bplz_core.{hpp,cpp}` | Portable C++17 core: gray, dither, ZPL compress, base64. No Nitro/JSI includes. |
| `cpp/HybridBplzCodec.{hpp,cpp}` | Nitro HybridObject. Validates input, copies the buffer, runs async. |
| `android/` | Gradle, CMake, Kotlin HybridObjects (`HybridClassicBluetooth`, `HybridClassicConnection`, `HybridBluetoothLE`, `HybridBleConnection`, `BleSupport`). |
| `ios/`, `NitroBplzLabel.podspec` | Swift HybridObjects with CoreBluetooth (`HybridBluetoothLE`, `HybridBleConnection`, `BleCentral`). The C++ codec is shared. |
| `nitro.json` | Autolinking map. Add every new HybridObject here. |
| `nitrogen/generated/` | Generated. Ships in the npm package. |
| `__tests__/` | Jest tests. |
| `test/reference/`, `test/mocks/` | Oracles and mocks for tests. |
| `test-native/` | C++ CLI and bench used by the parity test. |
| `scripts/check-cpp.sh` | C++ syntax check against Nitro and JSI headers + warning-free core build. |
| `scripts/check-ios.sh` | macOS only. Builds the pod in a temp React Native host app (`pod install`, `xcodebuild`). CI job `ios`. |
| `scripts/check-kotlin.sh` | Downloads kotlinc and Android jars into `.cache/`, compiles the Kotlin code. |
| `docs/TEARDOWN.md` | What we learned from the two vendor APKs and the SDK. |
| `docs/RECEIPT.md` | Receipt module: types, layout rules, limits, how to test with an emulator. |
| `docs/BLE.md` | BLE guide: setup, API, chunking, errors, troubleshooting, manual acceptance test. |
| `docs/BPLZ-TEST-LABELS.md` | 22 small test labels and 3 status queries to send with nRF Connect, and a result table. Tests check size and syntax only. |
| `docs/BPLZ-TEST-SHEET.md` | One test label with 12 numbered cells, sent as 9 writes with nRF Connect. The short way to test the BPLZ commands. Tests check size and syntax only. |
| `docs/BLE-HARDENING.md` | What mature BLE projects do (Nordic, Apple, Zebra, Epson, ble-plx, flutter_blue_plus), the audit of our BLE code, what is fixed and what is open. Read it before you change the BLE code. |
| `docs/REFERENCES.md` | Verification record. What was checked, what was only compiled, what is unchecked. |

## Releases

A release is a tag `vX.Y.Z` of `main`, made by the workflow `.github/workflows/release.yml` (Actions → Release → Run workflow, input: the version of `package.json`). An agent session cannot push tags (the remote refuses), so it starts that workflow instead. Apps pin the package by tag (`...rn-printing.git#v0.2.0`). To release: raise `version` in `package.json`, merge to `main`, run the workflow.

## Commands

```sh
npm ci
npm run typecheck        # tsc --noEmit
npm test                 # jest (includes C++ parity test; needs g++)
npm run build            # tsc -p tsconfig.build.json -> lib/
npx nitrogen             # regenerate nitrogen/generated after a spec change
bash scripts/check-cpp.sh
bash scripts/check-kotlin.sh   # first run downloads ~200 MB into .cache/
npm run bench            # Node V8 only; does not show Hermes or phone speed
```

CI (`.github/workflows/ci.yml`) runs all of these. Make them pass before you open a PR.

## How to do common changes

**Add a label feature (ZPL/CPCL/BPLA):**
1. Add the method to the builder in `src/zpl.ts` (or `cpcl.ts`, `bpla.ts`). Validate every number with `int()` from `src/validate.ts`.
2. Add a test in `__tests__/`. Check the exact command text.
3. For ZPL, you can render it on Labelary (see below) and compare with what you expect.
4. Note the source in `docs/REFERENCES.md`.

**Change the C++ core:**
1. Edit `cpp/bplz_core.cpp`. Keep it free of Nitro/JSI includes.
2. Update the matching oracle in `test/reference/` only if the rule itself changed (and cite a source).
3. Run `npm test` (parity test compares C++ with the oracle) and `bash scripts/check-cpp.sh`.

**Add a native function or object:**
1. Add or edit a `src/specs/X.nitro.ts` spec.
2. Run `npx nitrogen`. Commit `nitrogen/`.
3. Add the implementation class (`cpp/` or `android/.../kotlin`). Register it in `nitro.json` under `autolinking`.
4. For C++, add the new `.cpp` to `android/CMakeLists.txt` and to the podspec sources if needed.
5. Add a getter in `src/native.ts` and a setter for tests.
6. Run `check-cpp.sh` / `check-kotlin.sh`.

**Add a transport:**
1. Implement the `Transport` interface in `src/transports/`. Chunk writes. Respect the write timeout.
2. Export it from `src/index.ts`.
3. Test it with a fake (see `__tests__/transports.test.ts`).

## Reconnect rules (do not break)

- `LabelPrinter.withLink` owns reconnect. Transports stay simple: `connect`, `write`, `read`, `disconnect`.
- Never resend a job after a failed write unless the user set `resendAfterPartialWrite`. A resend can print twice.
- A transport must throw `TransportError` with a `code`. Codes in `TRANSIENT` (`src/reconnect.ts`) are retried. Give an error that the user must fix its own code, so it is not retried.
- Android messages from Kotlin are mapped to codes in `classify()` in `src/transports/bluetoothClassic.ts`. If you change a Kotlin error message, change `classify()` too.
- BLE native errors (Kotlin and Swift) start with a code in square brackets: `[E_BLUETOOTH_OFF] Bluetooth is off`. `classify()` in `src/transports/bluetoothLE.ts` reads it. Keep the codes of the two platforms the same. A new code that the user must fix must stay out of `TRANSIENT`.
- ONE retry layer: `LabelPrinter` + `src/reconnect.ts`, built on `cockatiel` (RetryPolicy, ExponentialBackoff, decorrelated jitter). Do not add retry inside a transport or add a second retry library. Do not hand-roll backoff.
- cockatiel `maxAttempts` counts retries, ours counts the first try too (`maxAttempts - 1`).
- Delay defaults (300 ms, x2, cap 2 s) are our choice and are not tested on the printer.
- A screen shows "not connected" from `LabelPrinter.health`, never from one raw link event (`onConnectionState`): one event is a wobble (Linux `link_watch`, NetworkManager and systemd-networkd wait a few seconds too). Do not copy this debounce into an app.
- A new error code goes in `src/errorCodes.ts` first. `__tests__/errorCodes.test.ts` checks Kotlin, Swift and TS against it.
- No background reconnect loop. Reconnect runs when a job starts.

## Facts you need

- ZPL ASCII compression: `G`-`Y` = 1-19, `g`-`z` = 20-400 in steps of 20, `,` = fill row with 0, `!` = fill row with 1, `:` = repeat previous row. Image command: `^GFA,total,total,bytesPerRow,data`.
- BPLZ and BPLC use a top-left origin. BPLA uses a bottom-left origin.
- The command language of the owner's TVS LP 46 Dlite is **BPLZ**, 203 dpi, 864 dots (108 mm) print width (its self-test print, `docs/REFERENCES.md`). Other units can differ: the self-test's COMMAND line tells.
- Android SDK Classic Bluetooth: SPP UUID `00001101-0000-1000-8000-00805F9B34FB`, secure socket first, then insecure, 1024-byte chunks.
- BLE has ONE implementation (`BluetoothLETransport`, native). Do not add a second BLE path or a third-party BLE library. NO UUID, name, MAC or PIN is built in, and none may be added to `src/`, `android/` or `ios/`. `BluetoothLETransport` reads the GATT table after the connect and chooses with `selectCharacteristics()`. A caller can pin UUIDs or pass `select()`. UUIDs of one printer may appear only in tests and docs, marked as examples.
- BLE on one TVS LP 46 Dlite: a user wrote BPLZ by hand to a writable characteristic (nRF Connect) and it printed. Our own code was not run on it.
- Labelary quirk: a `^PW` narrower than the label centers the print area. Remove `^PW`/`^LL` when you compare pixels.

## Verification status

| Area | Status |
| --- | --- |
| ZPL compression | Checked against Labelary (pixel exact) and the Zebra guide. |
| Threshold dither | Checked against Pillow. |
| Bayer 8x8 matrix | Checked against the recursive definition. |
| C++ vs TS reference | Differential tests in `__tests__/native-parity.test.ts`. |
| C++ vs Nitro/JSI headers | Syntax check only. Not run in a real app. |
| Kotlin | Compiled with kotlinc against Android API jar. Not run on a device. |
| Native BLE (TypeScript) | Unit-tested with a fake native layer. |
| Native BLE (Kotlin) | Compiled with kotlinc against the Android API jar. Not run on a device. |
| Native BLE (Swift / CoreBluetooth) | Compiled in CI (job `ios`, Xcode 26.6, iOS Simulator, host app with React Native 0.87.1; `scripts/check-ios.sh`). NOT run on a device or a simulator. |
| BLE `read` (GATT inspector) | TypeScript: unit-tested with a fake. Kotlin: compiled only. Swift: compiled in CI. Not run on a device. |
| BLE pairing (bonding) | TypeScript: unit-tested with a fake link (`withBond`, 8 tests). Kotlin: compiled (`createBond`, bond receiver). Swift: no pairing API on iOS; `bond()` is a stub. Not run on a device or the printer. |
| iOS round 3 (write timer, stale responses, connect attempts, piece size, permission wait) | Swift written from Apple's docs: compiled in CI, NOT run. The permission wait is unit-tested in TypeScript. See `docs/BLE-HARDENING.md` section 8. |
| iOS round 11 (app in the background: the lost-link reason; `rediscover` for a changed iOS device id) | Swift (`BleCentral`: background count, a clearer not-found message): written from Apple's docs, compiled in CI, NOT run. TypeScript (`bleRediscover.ts`, a cut write is `E_DISCONNECTED` with `nothingSent` false and is never sent again): unit-tested. Apple's `retrievePeripherals` reference page was not read. See `docs/BLE-HARDENING.md` section 16. |
| BLE audit fixes (op kinds in `GattOpGuard`, connect overlap, stale notifications, `E_AUTH` on connect) | TypeScript: unit-tested, and shown to fail without the fix. Kotlin: compiled; `GattOpGuard` JVM race test passes (42 checks). Not run on a device. |
| Receipt layout and ESC/POS bytes (`src/receipt.ts`) | TypeScript unit tests only. A real SPRT SP-POS894UED printed receipts over BLE (owner's photos, 2026-10-09). The cut is `GS V 66 0` / `GS V 65 0` (feed to the cutter, then cut; the vendor tool sends the same bytes): the plain cut cut the end of a receipt off. NOT checked on the printer after this change. Hermes (`structuredClone` guard) NOT run. |
| BLE failed pairing (`PairingWatch`, `E_AUTH` after a close with status 19) | Kotlin: compiled; the rule is tested on a JVM (11 checks). Not run on a device. Swift: not done (iOS pairs by itself). See `docs/BLE-HARDENING.md` section 11. |
| TCP transport (`TcpTransport`: `endJob()` closes the connection, 16 KiB pieces with progress and cancel, link events) | TypeScript: unit-tested with a fake socket (`__tests__/tcp-job.test.ts`). Not run with `react-native-tcp-socket`, a network printer, PrinterOne or `p910nd`. See `docs/REFERENCES.md`. |
| BLE write path vs BlueZ / Android (round 7: pairing inside a write, GATT_CONGESTED, state after link loss, inbox limit) | TypeScript: tests that fail without the fix (`__tests__/bluetoothLE-review.test.ts`). Kotlin: compiled; the two Kotlin fixes are argued from AOSP source, NOT run on a device. See `docs/BLE-HARDENING.md` section 12. |
| Classic Bluetooth and BLE connect path (round 8: a connect that finishes after dispose, SecurityException, older link still opening, the Classic reader thread and connect budget, the BLE settle delay, the disconnect drain, iOS pacing) | TypeScript: tests that fail without the fix (`__tests__/bluetoothClassic.test.ts`). Kotlin: compiled; argued from source, NOT run on a device. `BluetoothSocket.java` and the kernel `rfcomm/sock.c` were read (not `bt_sock_wait_ready`, `rfcomm_dlc_send`). See `docs/BLE-HARDENING.md` section 13. |
| Gradle, CMake builds | NOT run. |
| Xcode build of the pod | Runs in CI (job `ios`): `pod install` and `xcodebuild` for the Simulator in a throw-away host app. No signing, no device. |
| BPLA record layout | NOT tested on a printer. |
| `~HS` / `~HQES` / `~HI` / `~HM` / `^HH` replies | Real replies of a ready printer are in the tests (`docs/REFERENCES.md`). Replies with a fault were NOT seen. |
| Hermes / phone speed | NOT measured. |

## Open items

- Run the BLE manual acceptance test in `docs/BLE.md` on Android and iOS with the real printer.
- Confirm the label size in mm of the owner's media (the self-test says 561 dots long = about 70 mm).
- Test on a real device and printer: Bluetooth Classic, BLE, TCP.
- Confirm BPLA units and framing.
- Add iOS-side tests when a Mac build is available.
- Run the BLE hardware test (`example/BleHardwareTest.tsx`, plan in `docs/BLE.md`). Compare write modes and delays on the TVS, and set the defaults from the result. The `auto` mode (write without response first) and the 10 ms pacing are NOT checked on the printer.

## Style

- Doc comments and README use ASD-STE100 Simplified Technical English: short, active sentences.
- Commit messages: imperative, short.
