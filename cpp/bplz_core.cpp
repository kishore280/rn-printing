#include "bplz_core.hpp"

#include <cstring>

namespace bplz {

void grayFromRgba(const uint8_t* rgba, size_t w, size_t h, uint8_t* gray) {
  const size_t count = w * h;
  for (size_t p = 0, i = 0; p < count; ++p, i += 4) {
    const int a = rgba[i + 3];
    int g = (77 * rgba[i] + 150 * rgba[i + 1] + 29 * rgba[i + 2]) >> 8;
    if (a != 255) g = (g * a + 255 * (255 - a) + 127) / 255;
    gray[p] = static_cast<uint8_t>(g);
  }
}

static const uint8_t BAYER8[64] = {
    0,  32, 8,  40, 2,  34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4,  36, 14, 46,
    6,  38, 60, 28, 52, 20, 62, 30, 54, 22, 3,  35, 11, 43, 1,  33, 9,  41, 51, 19, 59, 27,
    49, 17, 57, 25, 15, 47, 7,  39, 13, 45, 5,  37, 63, 31, 55, 23, 61, 29, 53, 21};

void dither(const uint8_t* gray, size_t w, size_t h, Method m, int threshold, bool invert, uint8_t* out) {
  const size_t bpr = (w + 7) >> 3;
  const int inv = invert ? 1 : 0;

  if (m == Method::Threshold || m == Method::Bayer) {
    for (size_t y = 0; y < h; ++y) {
      const uint8_t* row = gray + y * w;
      uint8_t* outRow = out + y * bpr;
      const size_t bayerRow = (y & 7) << 3;
      for (size_t x = 0; x < w; ++x) {
        const int limit = (m == Method::Bayer) ? (BAYER8[bayerRow + (x & 7)] * 255) / 63 : threshold;
        if (((row[x] < limit) ? 1 : 0) ^ inv) outRow[x >> 3] |= static_cast<uint8_t>(0x80 >> (x & 7));
      }
    }
    return;
  }

  const size_t stride = w + 4;
  std::vector<int16_t> buf(stride * 3, 0);
  int16_t* cur = buf.data();
  int16_t* next = cur + stride;
  int16_t* next2 = next + stride;
  const bool atkinson = (m == Method::Atkinson);
  for (size_t y = 0; y < h; ++y) {
    const uint8_t* row = gray + y * w;
    uint8_t* outRow = out + y * bpr;
    for (size_t x = 0; x < w; ++x) {
      const int old = row[x] + cur[x + 2];
      const bool black = old < 128;
      const int err = old - (black ? 0 : 255);
      if ((black ? 1 : 0) ^ inv) outRow[x >> 3] |= static_cast<uint8_t>(0x80 >> (x & 7));
      const size_t c = x + 2;
      if (atkinson) {
        const int q = err >> 3;
        cur[c + 1] = static_cast<int16_t>(cur[c + 1] + q);
        cur[c + 2] = static_cast<int16_t>(cur[c + 2] + q);
        next[c - 1] = static_cast<int16_t>(next[c - 1] + q);
        next[c] = static_cast<int16_t>(next[c] + q);
        next[c + 1] = static_cast<int16_t>(next[c + 1] + q);
        next2[c] = static_cast<int16_t>(next2[c] + q);
      } else {
        cur[c + 1] = static_cast<int16_t>(cur[c + 1] + ((err * 7) >> 4));
        next[c - 1] = static_cast<int16_t>(next[c - 1] + ((err * 3) >> 4));
        next[c] = static_cast<int16_t>(next[c] + ((err * 5) >> 4));
        next[c + 1] = static_cast<int16_t>(next[c + 1] + (err >> 4));
      }
    }
    int16_t* spare = cur;
    cur = next;
    next = next2;
    next2 = spare;
    std::memset(next2, 0, stride * sizeof(int16_t));
  }
}

static const uint8_t HEX[16] = {'0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F'};

static size_t writeRun(uint8_t* out, size_t o, size_t count, uint8_t ch) {
  if (count == 1) {
    out[o++] = ch;
    return o;
  }
  size_t n = count;
  while (n > 400) {
    out[o++] = 'z';
    n -= 400;
  }
  if (n >= 20) {
    out[o++] = static_cast<uint8_t>('g' + (n / 20 - 1));
    n %= 20;
  }
  if (n > 0) out[o++] = static_cast<uint8_t>('G' + (n - 1));
  out[o++] = ch;
  return o;
}

size_t zplCompress(const uint8_t* data, size_t bpr, size_t rows, uint8_t* out) {
  const size_t hexPerRow = bpr * 2;
  std::vector<uint8_t> hex(hexPerRow);
  size_t o = 0;
  long prev = -1;
  for (size_t r = 0; r < rows; ++r) {
    const size_t base = r * bpr;
    if (prev >= 0 && std::memcmp(data + base, data + prev, bpr) == 0) {
      out[o++] = ':';
      prev = static_cast<long>(base);
      continue;
    }
    prev = static_cast<long>(base);
    for (size_t i = 0; i < bpr; ++i) {
      hex[i * 2] = HEX[data[base + i] >> 4];
      hex[i * 2 + 1] = HEX[data[base + i] & 15];
    }
    size_t end = hexPerRow;
    const uint8_t last = hex[hexPerRow - 1];
    int tail = 0;
    if (last == '0' || last == 'F') {
      size_t k = hexPerRow - 1;
      while (k > 0 && hex[k - 1] == last) --k;
      end = k;
      tail = (last == '0') ? 1 : 2;
    }
    size_t i = 0;
    while (i < end) {
      const uint8_t ch = hex[i];
      size_t j = i + 1;
      while (j < end && hex[j] == ch) ++j;
      o = writeRun(out, o, j - i, ch);
      i = j;
    }
    if (tail == 1) out[o++] = ',';
    else if (tail == 2) out[o++] = '!';
  }
  return o;
}

size_t base64Encode(const uint8_t* in, size_t n, uint8_t* out) {
  static const char T[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  size_t o = 0, i = 0;
  for (; i + 2 < n; i += 3) {
    const uint32_t v = (uint32_t(in[i]) << 16) | (uint32_t(in[i + 1]) << 8) | in[i + 2];
    out[o++] = T[(v >> 18) & 63];
    out[o++] = T[(v >> 12) & 63];
    out[o++] = T[(v >> 6) & 63];
    out[o++] = T[v & 63];
  }
  if (n - i == 1) {
    const uint32_t v = uint32_t(in[i]) << 16;
    out[o++] = T[(v >> 18) & 63];
    out[o++] = T[(v >> 12) & 63];
    out[o++] = '=';
    out[o++] = '=';
  } else if (n - i == 2) {
    const uint32_t v = (uint32_t(in[i]) << 16) | (uint32_t(in[i + 1]) << 8);
    out[o++] = T[(v >> 18) & 63];
    out[o++] = T[(v >> 12) & 63];
    out[o++] = T[(v >> 6) & 63];
    out[o++] = '=';
  }
  return o;
}

}  // namespace bplz
