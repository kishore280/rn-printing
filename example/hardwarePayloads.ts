/**
 * Test labels for the first real-printer BLE test (for example the TVS LP 46 Dlite, BPLZ, 203 dpi).
 * Nothing here knows about BLE. Each payload is plain BPLZ (ZPL II) bytes from the normal label builders,
 * so the same payloads also test TCP and Bluetooth Classic.
 *
 * The sizes follow the media and the dots per mm that you pass in. Nothing assumes 203 dpi:
 * 203 dpi = 8 dots/mm, 300 dpi = 12 dots/mm.
 */
import {
  compressBitmap,
  ditherGray,
  ZplLabel,
  type Bitmap1bpp,
  type DotsPerMm,
  type Printable,
} from 'react-native-bplz-label-printer';

export interface PayloadOptions {
  dotsPerMm?: DotsPerMm;
  /** Width and length of the media that is loaded, in mm. Default 50 x 30 (a small label). */
  labelWidthMm?: number;
  labelLengthMm?: number;
  /** Width and length of the media for the large image tests, in mm. Default 100 x 100. */
  largeWidthMm?: number;
  largeLengthMm?: number;
}

export interface HardwarePayload {
  id: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
  title: string;
  /** What to look for on the printed label. */
  expect: string;
  /** One label, or a list that is sent one after the other. */
  labels: Printable[];
}

/** Deterministic pseudo-random numbers (LCG), so the same image comes out every time. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s >>> 24; // 0..255
  };
}

/** A grey picture: a diagonal gradient with a ring and a cross. Easy to judge by eye. */
export function testPicture(width: number, height: number): Uint8Array {
  const gray = new Uint8Array(width * height);
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) / 2 - 4;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = Math.round(((x / width + y / height) / 2) * 255);
      const d = Math.hypot(x - cx, y - cy);
      if (Math.abs(d - radius) < 3) v = 0;
      if (Math.abs(x - cx) < 1.5 || Math.abs(y - cy) < 1.5) v = 0;
      gray[y * width + x] = v;
    }
  }
  return gray;
}

/** Grey noise. After a threshold it is random black and white dots: the worst case for ZPL compression. */
export function noisePicture(width: number, height: number, seed = 1): Uint8Array {
  const next = lcg(seed);
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) gray[i] = next();
  return gray;
}

async function imageLabel(
  gray: Uint8Array,
  widthDots: number,
  heightDots: number,
  label: ZplLabel,
  method: 'threshold' | 'floyd-steinberg' | 'atkinson' | 'bayer'
): Promise<ZplLabel> {
  const bitmap: Bitmap1bpp = await ditherGray(gray, widthDots, heightDots, { method });
  return label.image(0, 0, bitmap, await compressBitmap(bitmap));
}

/** Build all payloads A to G. Needs the native codec for the image payloads (E and F). */
export async function buildHardwarePayloads(options: PayloadOptions = {}): Promise<HardwarePayload[]> {
  const d = options.dotsPerMm ?? 8;
  const w = options.labelWidthMm ?? 50;
  const l = options.labelLengthMm ?? 30;
  const lw = options.largeWidthMm ?? 100;
  const ll = options.largeLengthMm ?? 100;
  const small = () => ZplLabel.fromMm(w, l, { dotsPerMm: d });
  const wDots = Math.round(w * d);
  const lDots = Math.round(l * d);

  const A = small().text(20, 20, 'HELLO FROM BLE', { height: 36 });

  const B = small()
    .box(2, 2, wDots - 4, lDots - 4, 2)
    .text(10, 10, 'TOP LEFT', { height: 24 })
    .text(Math.round(wDots / 2), Math.round(lDots / 2) - 12, 'CENTER', { height: 24 })
    .text(10, lDots - 40, 'BOTTOM LEFT', { height: 24 })
    .text(Math.round(wDots / 2), lDots - 40, 'x=' + Math.round(wDots / 2) + ' y=' + (lDots - 40), { height: 20 });

  const C = small().qr(20, 20, 'https://example.com/ble-test', { magnification: 4 }).text(Math.round(wDots / 2), 20, 'QR', { height: 30 });

  const D = small()
    .barcode128(20, 20, 'BLE-TEST-0123456789', { height: 80 })
    .text(20, 120, 'BLE-TEST-0123456789', { height: 24 });

  const logoSize = Math.min(wDots, lDots) - 20;
  const E = await imageLabel(testPicture(logoSize, logoSize), logoSize, logoSize, small(), 'floyd-steinberg');

  const lwDots = Math.round(lw * d);
  const llDots = Math.round(ll * d);
  const F = await imageLabel(
    testPicture(lwDots, llDots),
    lwDots,
    llDots,
    ZplLabel.fromMm(lw, ll, { dotsPerMm: d }),
    'floyd-steinberg'
  );
  // A noise picture does not compress: this is the biggest payload, 100 KB or more at 100 x 100 mm and 203 dpi.
  // It is a stress test for chunking. A lost or repeated piece shifts the picture and the printer stops or prints garbage.
  const F2 = await imageLabel(noisePicture(lwDots, llDots), lwDots, llDots, ZplLabel.fromMm(lw, ll, { dotsPerMm: d }), 'threshold');

  const G: Printable[] = [];
  for (let i = 1; i <= 10; i++) {
    G.push(small().text(20, 20, `LABEL ${i} OF 10`, { height: 30 }).barcode128(20, 70, String(1000 + i), { height: 60 }));
  }

  return [
    { id: 'A', title: 'HELLO FROM BLE', expect: 'One line of text.', labels: [A] },
    { id: 'B', title: 'Text and positioning', expect: 'A frame, with text in the four places named on the label.', labels: [B] },
    { id: 'C', title: 'QR code', expect: 'A QR code that a phone reads as https://example.com/ble-test.', labels: [C] },
    { id: 'D', title: 'Code 128', expect: 'A barcode that a scanner reads as BLE-TEST-0123456789.', labels: [D] },
    { id: 'E', title: 'Image / logo', expect: 'A grey picture with a ring and a cross, no shifted rows.', labels: [E] },
    {
      id: 'F',
      title: 'Large image-heavy label',
      expect: 'The same picture as E, large. No shifted or missing rows. Then the noise label: dense even noise, no blank bands.',
      labels: [F, F2],
    },
    { id: 'G', title: '10 labels in a row', expect: 'Ten labels, numbered 1 to 10 in order, none missing, none doubled.', labels: G },
  ];
}
