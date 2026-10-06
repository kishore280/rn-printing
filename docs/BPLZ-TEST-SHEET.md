# BPLZ test sheet: one label that tests many commands

This is the short way. One label (864 x 560 dots = 108 x 70 mm) holds 12 numbered cells. Each cell tests some commands.
Send the 9 parts below, in order, with nRF Connect. The printer keeps the data until `^XZ` and prints ONE label.
For the longer way (one label for each test, and the status queries) use `BPLZ-TEST-LABELS.md`.

Status: NOT run on a printer yet. A unit test checks that each part is short enough and that our parser reads the whole sheet.

## Before you start

1. The sheet is made for a label of 864 x 560 dots. If your label is smaller, the print is cut at the label edge and you
   lose cells. Then use the longer way, or change `^PW864^LL560` in part 1 (and expect cut cells).
2. Connect, request MTU 247 (the default 23 bytes is too small), and open the data characteristic that accepts writes.
3. Write each part as type **TEXT**, with a write request, one after the other, in order (Part 1, then Part 2, ...).
   Wait about a second between parts. Do not add a line break or a space.
4. Nothing prints until Part 9 (it has `^XZ`). If nothing prints a few seconds after Part 9, the printer rejected the data. Write that down.
5. If you send a part twice or in the wrong order, power the printer off and on, then start again from Part 1.
6. Do not send `~WN...` commands.

## What each cell tests (look at the number in the corner)

| Cell | Tests | What you should see |
| --- | --- | --- |
| frame | `^GB` full label (edges and margins) | A thin frame at the label edge. Note which sides are cut or shifted. |
| 1 | Fonts A, B, C, D, E, F, 0 (`^A`) | 7 lines, each "X Abc123". Note which fonts look different. |
| 2 | Rotation N, R, I, B | "Normal", "Right", "Invert", "Bottom" turned 0, 90, 180, 270 degrees. |
| 3 | `^CI28` UTF-8, `^FR` reverse | "Rs", rupee sign, e-acute, n-tilde. White text on a black bar. "NoBox" reversed on blank paper. |
| 4 | `^GB` thickness and corners | Three boxes (thin, medium, thick), a rounded box, a white box (may show nothing). |
| 5 | `^GD`, `^GE`, `^GC` | Two diagonals, an ellipse, a circle (`^GC` is not in the SDK list: it may be missing). |
| 6 | Code 128, Code 39 | Two barcodes with text. Scan them. |
| 7 | EAN-13, UPC-A | Two barcodes. The printer adds the check digit. Scan them. |
| 8 | ITF, Codabar, Code 93 | Three barcodes. Scan them. |
| 9 | QR codes | QR (M, size 3), QR (H, size 3), QR (M, size 4). Scan them. |
| 10 | PDF417, Data Matrix | One of each. |
| 11 | `^GFA` images | A tiny 8 x 8 checker (1 mm), and a 32 x 32 square (compressed data with `:`): left half black on the top half, right half black on the bottom half. |
| 12 | `^BY` widths, `^FT` | Three bars of the same data, each wider. The word "CF?" and "FT?" (the last one uses `^FT`, a baseline origin). |

## Parts

### Part 1 of 9

```zpl
^XA^PW864^LL560^FO0,0^GB864,560,2^FS^FO4,2^A0N,16,12^FD1^FS^FO24,4^AAN,16,9^FDA Abc123^FS^FO24,28^ABN,16,9^FDB Abc123^FS^FO24,52^ACN,16,9^FDC Abc123^FS^FO24,76^ADN,16,9^FDD Abc123^FS^FO24,100^AEN,16,9^FDE Abc123^FS
```

### Part 2 of 9

```zpl
^FO24,124^AFN,16,9^FDF Abc123^FS^FO24,148^A0N,16,9^FD0 Abc123^FS^FO220,2^A0N,16,12^FD2^FS^FO236,20^A0N,24,24^FDNormal^FS^FO406,20^A0R,24,24^FDRight^FS^FO336,175^A0I,24,24^FDInvert^FS^FO236,175^A0B,24,24^FDBottom^FS^FO436,2^A0N,16,12^FD3^FS
```

### Part 3 of 9

```zpl
^CI28^FO442,24^A0N,24,24^FH_^FDRs _E2_82_B9 _C3_A9 _C3_B1^FS^FO442,70^GB190,44,44^FS^FO448,76^A0N,30,30^FR^FDREV^FS^FO442,130^A0N,24,24^FR^FDNoBox^FS^FO652,2^A0N,16,12^FD4^FS^FO658,24^GB60,40,1^FS^FO728,24^GB60,40,4^FS
```

### Part 4 of 9

```zpl
^FO798,24^GB56,40,10^FS^FO658,90^GB90,60,4,B,4^FS^FO768,90^GB80,60,4,W,0^FS^FO4,188^A0N,16,12^FD5^FS^FO10,210^GD70,70,3,B,R^FS^FO90,210^GD70,70,3,B,L^FS^FO10,296^GE100,60,3^FS^FO130,296^GC60,3^FS^FO220,188^A0N,16,12^FD6^FS
```

### Part 5 of 9

```zpl
^BY2^FO226,210^BCN,50,Y,N,N^FD12345678^FS^FO226,296^B3N,N,50,Y,N^FDAB12^FS^FO436,188^A0N,16,12^FD7^FS^BY2^FO442,210^BEN,50,Y,N^FD590123412345^FS^FO442,296^BUN,50,Y,N,Y^FD03600029145^FS^FO652,188^A0N,16,12^FD8^FS
```

### Part 6 of 9

```zpl
^BY2^FO658,206^B2N,34,Y,N,N^FD1234^FS^FO658,264^BKN,N,34,Y,N,A,B^FDA12B^FS^FO658,322^BAN,34,Y,N,N^FDABC^FS^FO4,374^A0N,16,12^FD9^FS^FO10,396^BQN,2,3^FDMA,HELLO 123^FS^FO110,396^BQN,2,3^FDHA,HELLO 123^FS^FO10,468^BQN,2,4^FDMA,HELLO 123^FS
```

### Part 7 of 9

```zpl
^FO220,374^A0N,16,12^FD10^FS^BY1^FO226,396^B7N,6,2,,,N^FDPDF417 12345^FS^FO226,482^BXN,5,200^FDDM 12345^FS^FO436,374^A0N,16,12^FD11^FS^FO442,396^GFA,8,8,1,AA55AA55AA55AA55^FS
```

### Part 8 of 9

```zpl
^FO492,396^GFA,128,128,4,FFFF0000:::::::::::::::0000FFFF:::::::::::::::^FS^FO652,374^A0N,16,12^FD12^FS^BY1^FO658,396^BCN,22,N,N,N^FD1234^FS^BY2^FO658,428^BCN,22,N,N,N^FD1234^FS^BY3^FO658,460^BCN,22,N,N,N^FD1234^FS
```

### Part 9 of 9

```zpl
^FO658,492^A0N,20,20^FDCF?^FS^FT658,548^A0N,20,20^FDFT?^FS^PQ1^XZ
```

## Result

For each cell write P (printed as expected), D (different, describe) or N (nothing). Send the result with a photo of the sheet.

| Item | P / D / N | What you saw |
| --- | --- | --- |
| Whole sheet printed | | |
| Frame and edges | | |
| 1 fonts | | |
| 2 rotation | | |
| 3 UTF-8 and reverse | | |
| 4 boxes | | |
| 5 diagonal, ellipse, circle | | |
| 6 Code 128, Code 39 | | |
| 7 EAN-13, UPC-A | | |
| 8 ITF, Codabar, Code 93 | | |
| 9 QR | | |
| 10 PDF417, Data Matrix | | |
| 11 images | | |
| 12 widths, FT | | |
