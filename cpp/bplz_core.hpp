// Portable C++17 core for the hot loops. No heap use inside the loops, no exceptions.
// It follows src/dither.ts, src/zplCompress.ts and src/encoding.ts bit for bit.
// Use it from a Nitro HybridObject or from JSI: it only needs raw pointers.
#pragma once
#include <cstddef>
#include <cstdint>
#include <vector>

namespace bplz {

enum class Method : int { Threshold = 0, FloydSteinberg = 1, Atkinson = 2, Bayer = 3 };

// RGBA (w*h*4 bytes) -> grey (w*h bytes). Integer weights 77/150/29, alpha over white.
void grayFromRgba(const uint8_t* rgba, size_t w, size_t h, uint8_t* gray);

// grey -> packed 1-bit rows (bytesPerRow = (w+7)/8). out must be zeroed, size bytesPerRow*h.
void dither(const uint8_t* gray, size_t w, size_t h, Method m, int threshold, bool invert, uint8_t* out);

// Packed bitmap -> ZPL ASCII-compressed hex. Returns the bytes written to `out`.
// `out` needs at least data_len*2 + rows + 16 bytes.
size_t zplCompress(const uint8_t* data, size_t bytesPerRow, size_t rows, uint8_t* out);

// Base64. `out` needs ((n+2)/3)*4 bytes. Returns bytes written.
size_t base64Encode(const uint8_t* in, size_t n, uint8_t* out);

}  // namespace bplz
