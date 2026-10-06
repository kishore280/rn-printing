# SNBC / TVS LP 46 D Lite: Teardown Findings

Source: SNBC Android label SDK V2.4.2.1 (docs, demo source, demo APK) and the BYLabel app APK (partial download).

## 1. The printer

- TVS LP 46 D Lite is a rebrand of the SNBC BTP-4200E.
- 203 dpi (8 dots/mm). Maximum width 108 mm.
- Options: Bluetooth or WiFi.

## 2. Command languages

- The SNBC family has four sets: BPLZ (ZPL II emulation), BPLA, BPLE and BPLC (CPCL style).
- The manual and the SDK show no TSPL and no ESC/POS. The GGFIX app claims TSPL2 for this model. This conflicts with the manual.
- The firmware variant can differ per unit. The self-test COMMAND line shows the real one. **Not yet confirmed for the user's unit.**
- SDK language codes: BPLZ=2, BPLC=4, BPLA=6. The app selects the language. The printer does not.

## 3. Bluetooth

- The SDK demo and BYLabel both use Bluetooth Classic SPP (RFCOMM, UUID `00001101-0000-1000-8000-00805F9B34FB`).
- **Correction:** the SNBC C SDK manual lists `PORT_TYPE_BLUETOOTH_BLE = 6` ("BT BLE: incoming device Bluetooth MAC address. iOS support."). So the SNBC printers can use BLE, and SNBC's iOS SDK uses it. The Android SDK demo uses Classic only. The GATT service and characteristic UUIDs are NOT in the manual or the Android library. Find them with nRF Connect.
- The user's unit BLE support is not verified. Test with nRF Connect.
- Connection flow:
  1. The user pairs the printer in phone settings.
  2. The app lists bonded devices.
  3. The app opens a secure RFCOMM socket. BYLabel falls back to an insecure socket.
  4. The app writes in 1024-byte chunks.
  5. The app reads by polling: 10 ms poll, 150 ms idle gap.
- Timeouts: read 5000 ms, write 3000 ms.
- Port types in the SDK: Bluetooth=7, network=4.

## 4. ZPL commands in the SDK native library

`^XA ^PW ^LL ^CI28 ^FO ^A@ ^BC ^BQ ^GB ^GFA ^PQ ^XZ ~HS ~HQES ~DG ^MM ^MT ^PR`

- `~HS` (host status) is not tested on the user's printer.
- `^CI28` selects UTF-8.

## 4b. BPLC and BPLA command strings (from the native library)

- BPLC is CPCL: `! offset hdpi vdpi height qty`, `PW`, `TEXT/TEXT90/TEXT180/TEXT270 font size x y data`, `SCALE-TEXT`, `BARCODE/VBARCODE type width ratio height x y data`, `BOX`, `LINE`, `CG` (bitmap), `PCX`, `VB PDF-417`, `VB QR x y M n U n` then `MA,data`, `PRINT`.
- BPLC settings: `! U1 SPEED n`, `! U1 TONE n`, `! U1 PRINT-MODE T|P|R|C N`, `! U1 MEDIA-CALIBRATE`, `! U1 setvar "media.sense_mode" "gap"|"bar"`, `! U1 PRN-CONFIG-LIST`, `! U1 do "device.reset" ""`.
- BPLA looks like the Datamax-style record language: text `rot font hmult vmult 000 row col data`, smooth font `rot 9 hmult vmult size row col data`, barcode `rot letter wide narrow height3 row col data`, box `1X11000 row col b length height top side`, `Q%04d` quantity, `H%02d` heat, `P%c` speed.
- BPLA origin is the bottom-left corner. BPLZ and BPLC use the top-left corner.
- SDK port timeouts: read 2000 ms, write 3000 ms by default.

## 5. iPhone

- Bluetooth Classic SPP on iOS needs Apple MFi. The printer has no MFi chip as far as we know.
- iPhone can use BLE (the SNBC SDK has a BLE port with iOS support) or TCP port 9100 (Ethernet or WiFi option).
- No iOS SDK is on snbc.cn.

## 6. Files and downloads

- Direct pattern on snbc.cn: `https://www.snbc.cn/index.php?m=home&c=View&a=custom_download_file&aid=<id>&field=<token>&lang=cn`
- aid values: Android label SDK 1667, Windows label SDK 1680, Linux label SDK 1745, POS Android 1679, BPLA&BPLZ test tool 1674, BYLabel APP 1802, BYLabel PC 1803.
- SDK list page: https://www.snbc.cn/Secondary_Development/
- snbc.com.cn was refused by the proxy. snbc.cn works.
- The BYLabel download has no range support. The zip was cut at about 62 of 66 MB. DEX files, manifest and arm64 libs were complete.

## 7. Open items

1. Print the self-test label. Read the COMMAND line.
2. Run the demo APK. Check which language prints.
3. Scan with nRF Connect on iPhone. Check for BLE.
4. Measure the label size in mm.
5. Test `~HS`.

## 8. This package

- TypeScript: ZPL (BPLZ), CPCL (BPLC) and BPLA builders, image printing, status parsers, Bluetooth Classic, BLE and TCP transports, `LabelPrinter`.
- Android Kotlin module: written, not compiled, not tested on a device.
- No SNBC code or binaries are included.
- BPLA and BPLC command formats come from native-library strings and public language docs. They are not tested on a printer.
- BPLA images and PDF417/QR are not supported.
- BLE needs the right GATT UUIDs for the printer. They are unknown.
