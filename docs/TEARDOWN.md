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

## 4a. Full BPLZ command list in the SDK native library (V2.4.2.1)

Source: `strings` on `libLabelPrinterSDK.so` (arm64-v8a, same in the other ABIs) and the SDK C and Java API guides.
The SDK was read, not run. No command here is checked on a printer.

Label content (format strings, `%` = a value the SDK fills in):

| Command | SDK format string |
| --- | --- |
| Text | `^A@<font>,<h>,<w>,<name>^FO<x>,<y>^FH_^FD<text>^FS` (reverse: add `^FR` before `^FD`) |
| Code page | `^CI<n>`. The SDK knows 0, 13, 27 to 31, 33 to 36. UTF-8 = 28. |
| Code 128 | `^FO..^BY<module>,<ratio>^BC<rot>,<h>,<hri>,<above>^FH_^FD..` |
| Other 1D | `^B2` (ITF), `^B3` (Code 39), `^B8` (EAN-8), `^B9` (UPC-E), `^BA` (Code 93), `^BE` (EAN-13), `^BK` (Codabar), `^BU` (UPC-A) |
| QR | `^FO..^BQ<rot>,<model>,<cell>^FH_^FD<ecc>A,<data>` |
| Data Matrix | `^FO..^BX<rot>,<cell>,200,...` |
| PDF417 | `^FO..^BY<module>^B7<rot>,<h>,<sec>,<cols>,<rows>,N^FH_^FD..` |
| MaxiCode-like `^BD` | `^FO..^BD<mode>,1,1^FH_^FD..` (seen in strings; not in the API guide) |
| Box | `^FO..^GB<w>,<h>,<t>,B,0^FS` or `^GB<w>,<h>,<t>^FS` |
| Diagonal | `^FO..^GD<w>,<h>,<t>,B,<dir>^FS` |
| Ellipse | `^FO..^GE<w>,<h>,<t>,B^FS` |
| Bitmap | `^FO..^GFA,<total>,<total>,<bytesPerRow>,<data>` |
| Stored image | `^FO..^IM<name>^FS`, `^FO..^XG<name>,1,1^FS` |
| Field number | `^FN<n>^FD` |

Page and printer setup: `^XA^PW<w>^LL<h>`, `^LH`, `^LS`, `^LT`, `^MM`, `^MT`, `^PO`, `^PR`, `^ST`, `^PQ<n>,,<copies>`, `^XZ`.
Storage: `~DG`, `~DY` (B/X and b/T variants). Control: `~HS`, `~HQES`, `~HL`, `~JA`, `~JC`, `~JR`, `~PH`, `~PP`, `~PS`, `~SD`, `~TA`, `~WC`.
Other: `^RF*`, `^RL*`, `^RR`, `^RS`, `^RW`, `^WV` (RFID), `^HF ^HR ^HW ^ID ^CN ^JB ^JS ^JU ^MN ^XF` (storage and host).
Also seen: `~WN00@eep,r,...` and `~WN00@ini,r,...` (SNBC private commands that read printer settings).

Value ranges from the C API guide (BPLZ column):

- Coordinates and sizes: 0 to 32000 dots. Label width 2 to 32000, height 1 to 32000.
- Font name: `A` to `Z` or `0` to `9`. Font width and height: 0 to 32000 dots. Style 1 = reverse.
- 1D barcode: height 1 to 32000. HRI 0 = none, 1 = below, 4 = above. Module width 1 to 10 (default 2). Wide/narrow ratio 2.0 to 3.0 (default 3.0). The ratio has no effect on Code 128, Code 93, EAN and UPC.
- QR: cell 1 to 10. ECC `H`, `Q`, `M` (default), `L`. Model 1 or 2 (default 2).
- PDF417: security 0 to 8, module width 1 to 10, module height 1 to 32000, rows 3 to 90, columns 1 to 30.
- Line and box thickness: 1 to 32000 (default 1). Box width and height: at least the thickness.
- Code page: 0 = U.S.A. 1, 24 = single-byte Asian, 28 = UTF-8, 29 = UTF-16 BE, 30 = UTF-16 LE.
- Print speed: 2 to 14 inch/s (varies by model). Label offset: -9999 to 9999 (X) and -240 to 240. `SetTearOffset` and label offset work in BPLZ only.
- Coordinates in BPLZ and BPLC give the top-left corner.

What this means for a preview or validator:

- The SDK sends about 25 label commands. A renderer for those covers what the vendor itself uses.
- The SDK does not use `^CF`, `^FB`, `^FW`, `^FT`, `^GFB`, `^A0` or `^FR` together with `^FO` for most text. It uses `^A@` for text. Our own builder uses `^A0`. The printer prints `^A0` (hardware test), so both work.
- `docs/` has no SNBC list of supported commands. The SDK shows only what SNBC sends. It does not show what the printer rejects.

## 4c. SNBC "LabelPrinter Config Tool (BPLZ&E)" V1.20 and BarPrnTest (BPLA) V3.23 / V4.0

Source: the zip "BPLA&BPLZ debug tools" from snbc.cn (Utility Software). We read the help files (CHM), the language file and the strings of the files. We did not run any program in it.

- **There is no command manual in it.** The help files only explain the tool (port settings, send area, download, EEPROM dialog). They point to "related information" for command help. SNBC does not publish a BPLZ command list here.
- The tool has a free "send area". It sends the text as typed (text or hex). It prints a test page and queries the version (`~WN01@version~`).
- **Private SNBC commands** seen in its strings (not Zebra, not documented): `~WN00@eep,r,...` and `~WN00@eep,w,<address>,...` (read and write printer EEPROM), `~WN00@ini,r|w,PrinterName|TphAdj|...`. **We do not send EEPROM writes.** A wrong write can change the printer for good.
- Other commands it sends: `^XA^JBE^XZ` (format flash?), `^XA^JUS^XZ`, `^XA^WD*:*.*^XZ` (list stored files). Meaning not verified.
- The language file lists the EEPROM settings by address. This tells us what the printer can be set to, and so which values a label can depend on:

| Setting | Values | Address |
| --- | --- | --- |
| Print mode | rewind, tear off, peel off, cut | 0x1C |
| Paper type | continuous, mark sensing, web (gap) sensing | 0x1C |
| Sensor | reflective, transmission, automatic | 0x2B |
| Power-up action | no feed, feed to next label, calibrate | 0x1D |
| Cover-close action | no feed, feed to next label, set label length, calibrate | 0x1D |
| Alignment mode | left, center, right | 0x04 |
| Left and right margin, TPH width | numbers | 0x04, 0x03 |
| Label length, max label length, max calibration length | numbers | 0x00, 0x1A, 0x19 |
| Print speed, feed speed, backfeed speed, darkness | numbers | 0x0F, 0x10, 0x11, 0x12 |
| Serial port | 2400 to 115200 baud, DTR/DSR or Xon/Xoff | 0x20 |

- **Alignment mode (left, center, right) matters for previews.** If the printer is set to center, a label narrower than the print width can print shifted, as Labelary does for `^PW`. Our preview does not model this. Check the unit's setting.
- Its port file lists `BTP-4200E(U)` (203 dpi) and `BTP-7400 (300 dpi)` as USB names.

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
