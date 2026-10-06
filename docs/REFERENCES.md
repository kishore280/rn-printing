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
| BLE adapter | `react-native-ble-plx` 3.5.1 type definitions | Type-checks against the real types. |
| iOS limit | [Apple developer forums](https://developer.apple.com/forums/thread/72148) | Bluetooth Classic (SPP) needs MFi. Public CoreBluetooth is BLE only. |
| ZPL barcode and `^BQ` parameters | Zebra ZPL II programming guide | Parameter order as documented. |
| BPLA text record layout | Datamax DPL record table (rotation, font, width mult, height mult, size, row, column) and the format strings inside SNBC's own library | Same layout. |
| BPLC (CPCL) | Zebra and Brother CPCL manuals; command strings inside SNBC's library | Same commands. |

## Compiled, not run

- **C++:** `HybridBplzCodec` and the core compile against the real Nitro and JSI headers (`g++ -std=c++20 -fsyntax-only`).
  The core is also built and run on the host, and compared with the TypeScript reference on random data
  (`__tests__/native-parity.test.ts`).
- **Kotlin:** `HybridClassicBluetooth` and `HybridClassicConnection` compile with `kotlinc` 2.1.21 against the Android 14
  API jar, the real Nitro Kotlin sources and the real `react-android` 0.87.1 classes. Only two annotations were stubbed.

## Not checked

- Anything on a real device or a real SNBC printer.
- The Android and iOS native builds (Gradle, CMake, Xcode). The build files come from the official scaffold.
- The BPLA row and column units, and the `Q`, `E`, `<STX>L` framing.
- The `~HS` and `~HQES` replies of the SNBC firmware.
- The GATT UUIDs of the printer's BLE module.
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
