# BPLZ test labels (send with nRF Connect)

Purpose: find out which ZPL commands the TVS LP 46 Dlite (BPLZ) really prints, and how.
SNBC publishes no BPLZ command manual. The print is the only proof.

Status of this file: the labels are NOT run on a printer yet. The unit test `__tests__/zplTestLabels.test.ts`
checks only that each label is short enough for one write and that our own parser reads it.
Fill the result table at the end after you print them.

## Before you start

1. Load a roll. Run the printer self-test and read the label length and width in dots (8 dots = 1 mm).
2. In every label below, `^PW400^LL240` is a placeholder (50 mm x 30 mm). Change `400` to your label width in dots
   and `240` to your label length. Keep the other numbers: they place things inside that area.
3. Only one test per label. Print them one at a time. Write what you see in the result table.

## How to send a label with nRF Connect

1. Connect to the printer. Find the data characteristic that accepts writes. (One unit used a Microchip
   transparent UART service with the data input `...8841...`. UUIDs of other units can differ. This is an example only.)
2. Request a bigger MTU first (menu, "Request MTU", 247). The default 23 bytes allows only 20 bytes per write.
   With MTU 247 one write can hold up to 244 bytes. Every label here is 200 bytes or less.
3. Tap the up-arrow (write) icon on the characteristic. Choose the type **TEXT** (not BYTE ARRAY), paste the label, send.
   Use **Write Request** (with response) first. It is slower and safe. You can try **Write Command** (without response) later.
4. Do not add a line break at the end. Do not add spaces inside a command.
5. The label prints at `^XZ`. If nothing prints in 5 seconds, the printer did not accept it. Write that down.
6. For the status tests at the end, also turn on notifications on the notify characteristic (the triple-arrow icon)
   before you send, so the reply shows in the log.

Notes:
- An unknown ZPL command is usually ignored without an error. A missing item on the print means "not supported".
- Do not send `~WN...` commands. They write to the printer memory.

## Labels

### T01 baseline text

```zpl
^XA^PW400^LL240^FO20,20^A0N,40,40^FDT01 OK^FS^XZ
```
Expect: the words "T01 OK" at the top left.

### T02a fonts A to C

```zpl
^XA^PW400^LL240^FO10,10^AAN,18,10^FDA font ABC 123^FS^FO10,60^ABN,18,10^FDB font ABC 123^FS^FO10,110^ACN,18,10^FDC font ABC 123^FS^XZ
```
Expect: three lines. Note how the shapes differ (bitmap fonts A, B, C).

### T02b fonts D to F

```zpl
^XA^PW400^LL240^FO10,10^ADN,18,10^FDD font ABC 123^FS^FO10,60^AEN,18,10^FDE font ABC 123^FS^FO10,110^AFN,18,10^FDF font ABC 123^FS^XZ
```

### T02c fonts G, H and 0

```zpl
^XA^PW400^LL240^FO10,10^AGN,18,10^FDG font ABC 123^FS^FO10,60^AHN,18,10^FDH font ABC 123^FS^FO10,110^A0N,18,10^FD0 font ABC 123^FS^XZ
```

### T03 rotation

```zpl
^XA^PW400^LL240^FO20,20^A0N,30,30^FDNormal^FS^FO380,20^A0R,30,30^FDRight^FS^FO260,230^A0I,30,30^FDInvert^FS^FO20,230^A0B,30,30^FDBottom^FS^XZ
```
Expect: four words turned 0, 90, 180 and 270 degrees. Note where each one starts.

### T04 UTF-8 text

```zpl
^XA^PW400^LL240^CI28^FO10,20^A0N,30,30^FH_^FDRs _E2_82_B9 cafe _C3_A9 _C3_B1^FS^XZ
```
Expect: "Rs", then a rupee sign, "cafe", then e-acute and n-tilde. A missing glyph may print as a box or a blank.

### T05 reverse text on a filled box

```zpl
^XA^PW400^LL240^FO10,10^GB380,60,60^FS^FO20,20^A0N,40,40^FR^FDREVERSE^FS^FO10,100^A0N,40,40^FR^FDNo box^FS^XZ
```
Expect: white text on a black bar. Second line: reverse on an empty area (black text, or nothing).

### T06 box thickness and corners

```zpl
^XA^PW400^LL240^FO10,10^GB100,60,1^FS^FO130,10^GB100,60,4^FS^FO250,10^GB100,60,12^FS^FO10,100^GB100,60,4,B,4^FS^FO130,100^GB100,60,4,W,0^FS^XZ
```
Expect: three boxes with thin, medium and thick lines. Then a box with rounded corners. The last box (white) may show nothing.

### T07 diagonal, ellipse, circle

```zpl
^XA^PW400^LL240^FO10,10^GD100,100,4,B,R^FS^FO130,10^GD100,100,4,B,L^FS^FO250,10^GE120,80,4^FS^FO10,140^GC80,4^FS^XZ
```
Expect: two diagonals (one each way), an ellipse, a circle. `^GC` is not in the SNBC SDK. It may print nothing.

### T08a Code 128 and Code 39

```zpl
^XA^PW400^LL240^BY2^FO10,10^BCN,50,Y,N,N^FD12345678^FS^FO10,110^B3N,N,50,Y,N^FDABC-123^FS^XZ
```
Expect: two barcodes with text below. Scan them with a phone.

### T08b EAN-13 and UPC-A

```zpl
^XA^PW400^LL240^BY2^FO10,10^BEN,50,Y,N^FD590123412345^FS^FO10,110^BUN,50,Y,N,Y^FD03600029145^FS^XZ
```
Expect: the printer adds the check digit. Scan them.

### T08c ITF and Codabar

```zpl
^XA^PW400^LL240^BY2^FO10,10^B2N,50,Y,N,N^FD123456^FS^FO10,110^BKN,N,50,Y,N,A,B^FDA1234B^FS^XZ
```

### T08d Code 93 and EAN-8

```zpl
^XA^PW400^LL240^BY2^FO10,10^BAN,50,Y,N,N^FDABC123^FS^FO10,110^B8N,50,Y,N^FD9638507^FS^XZ
```

### T09 bar module width

```zpl
^XA^PW400^LL240^BY1^FO10,10^BCN,40,N,N,N^FD12345^FS^BY2^FO10,80^BCN,40,N,N,N^FD12345^FS^BY3^FO10,150^BCN,40,N,N,N^FD12345^FS^XZ
```
Expect: three bars of the same data, each wider than the one before. Measure the widths with a ruler.

### T10 QR codes

```zpl
^XA^PW400^LL240^FO10,10^BQN,2,3^FDMA,HELLO 123^FS^FO150,10^BQN,2,3^FDHA,HELLO 123^FS^FO10,120^BQN,2,6^FDMA,HELLO 123^FS^XZ
```
Expect: three QR codes. The second has a higher error correction (denser). The third is larger. Scan them.

### T11 PDF417 and Data Matrix

```zpl
^XA^PW400^LL240^FO10,10^B7N,8,2,,,N^FDPDF417 TEST 12345^FS^FO10,130^BXN,6,200^FDDM TEST 12345^FS^XZ
```

### T12a image, plain hex

```zpl
^XA^PW400^LL240^FO10,10^GFA,8,8,1,AA55AA55AA55AA55^FS^XZ
```
Expect: a tiny 8 x 8 dot checkerboard (1 mm). Look with a magnifier.

### T12b image, compressed

```zpl
^XA^PW400^LL240^FO10,10^GFA,128,128,4,FFFF0000:::::::::::::::0000FFFF:::::::::::::::^FS^XZ
```
Expect: a 32 x 32 dot square. The top half is black on the left half and the bottom half is black on the right half.
This tests the compression with the repeat character `:`.

### T13 copies

```zpl
^XA^PW400^LL240^FO20,20^A0N,40,40^FDCopies 3^FS^PQ3^XZ
```
Expect: three identical labels.

### T14 commands that are not in the SDK list

```zpl
^XA^PW400^LL240^CF0,30,30^FO10,10^FDCF test^FS^FO10,60^FB300,2,0,L^FDFB wrap: long text that wraps onto a second line^FS^FT10,200^A0N,30,30^FDFT baseline^FS^XZ
```
Expect: each line that prints shows that the printer supports `^CF`, `^FB` and `^FT`. A missing line means not supported.

### T15 label edges and margins

```zpl
^XA^PW400^LL240^FO0,0^GB400,240,2^FS^XZ
```
Expect: a frame at the label edge. Note which sides are cut or shifted. This shows the margin and the alignment mode.

### T16 home offset

```zpl
^XA^PW400^LL240^LH50,50^FO0,0^GB60,60,60^FS^XZ
```
Expect: a black square 50 dots from the left and the top edge.

## Status queries (no print)

Turn on notifications first. Send each text alone. Copy the reply from the log (as text and as hex).

```zpl
~HS
```

```zpl
~HQES
```

```zpl
~HI
```

Expect: each gives a text reply. `~HS` should give three lines. Our parser expects that.

## Result table

Fill in: P = printed as expected, D = printed but different (describe), N = nothing or not printed.

| Test | P / D / N | What you saw |
| --- | --- | --- |
| T01 baseline | | |
| T02a fonts A-C | | |
| T02b fonts D-F | | |
| T02c fonts G, H, 0 | | |
| T03 rotation | | |
| T04 UTF-8 | | |
| T05 reverse | | |
| T06 boxes | | |
| T07 diagonal, ellipse, circle | | |
| T08a Code 128, Code 39 | | |
| T08b EAN-13, UPC-A | | |
| T08c ITF, Codabar | | |
| T08d Code 93, EAN-8 | | |
| T09 module width | | |
| T10 QR | | |
| T11 PDF417, Data Matrix | | |
| T12a image hex | | |
| T12b image compressed | | |
| T13 copies | | |
| T14 CF, FB, FT | | |
| T15 edges | | |
| T16 home offset | | |
| `~HS` reply | | |
| `~HQES` reply | | |
| `~HI` reply | | |

Send photos of the prints and the reply text. Then we can fix the parser, the checker and the preview from facts.
