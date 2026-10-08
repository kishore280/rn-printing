# Food pack labels (India, FSSAI)

Status: design notes. Nothing here is checked on a printer. This is not legal advice. The shop must confirm the rules with FSSAI.

## What the rules ask for

Source: FSSAI Labelling and Display Regulations, compendium version VI (2023), `https://fssai.gov.in/upload/uploadfiles/files/Comp_Labelling.pdf`.

- FSSAI logo and licence number, "in contrast colour to the background" (regulation 5(7)(a)). Black on white is a contrast colour.
- Veg or non-veg symbol (regulation 5(4)). The text names a **green** filled circle in a green square (veg) and a **brown** filled triangle in a brown square (non-veg). It gives no black-and-white rule. The owner decided to print it black and white. Whether FSSAI accepts this is NOT confirmed.
- Minimum symbol size by the area of the principal display panel (regulation 5(4)(c)):

| Area (sq cm) | Circle (mm) | Triangle side (mm) | Square side (mm) |
| --- | --- | --- | --- |
| up to 100 | 3 | 2.5 | 6 |
| 100 to 500 | 4 | 3.5 | 8 |
| 500 to 2500 | 6 | 5 | 12 |
| over 2500 | 8 | 7 | 16 |

- Net quantity, retail price (MRP), date of manufacture or packing, expiry or best-before date, name and address of the maker.
- A direction of 6 January 2023 (quoted in the compendium) lets small packs of 100 sq cm or less leave out some logos. Check what it covers.

## What we built

- `src/design.ts`: a design (items in mm) becomes ZPL. `vegSymbolZpl` draws the symbols with `^GB` and `^GE`. The non-veg triangle is a stack of `^GB` bars.
- The package does not contain the FSSAI logo. The logo is FSSAI's own file (`FSSAI-logo-min+line.png`, from `https://stg-old.fssai.gov.in/knowledge-hub-logos.php?pages=2`). FSSAI publishes PNG, not SVG. The app converts it to a black-and-white bitmap at the size of the label.
