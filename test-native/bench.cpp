#include <chrono>
#include <cstdio>
#include <vector>
#include "../cpp/bplz_core.hpp"
using clk = std::chrono::steady_clock;
static double ms(clk::time_point a) { return std::chrono::duration<double, std::milli>(clk::now() - a).count(); }
int main() {
  const size_t w = 864, h = 1200;  // full 108 mm head at 203 dpi, 150 mm tall
  std::vector<uint8_t> rgba(w * h * 4), gray(w * h), bits(((w + 7) / 8) * h), comp(w * h), b64((w * h * 4 / 3) + 8);
  uint32_t s = 1;
  for (auto& b : rgba) { s = s * 1664525u + 1013904223u; b = (s >> 24); }
  for (size_t i = 3; i < rgba.size(); i += 4) rgba[i] = 255;
  const int N = 20;
  auto t = clk::now(); for (int i = 0; i < N; i++) bplz::grayFromRgba(rgba.data(), w, h, gray.data());
  printf("cpp gray      %.2f ms\n", ms(t) / N);
  t = clk::now(); for (int i = 0; i < N; i++) { std::fill(bits.begin(), bits.end(), 0); bplz::dither(gray.data(), w, h, bplz::Method::FloydSteinberg, 128, false, bits.data()); }
  printf("cpp floyd     %.2f ms\n", ms(t) / N);
  t = clk::now(); for (int i = 0; i < N; i++) bplz::zplCompress(bits.data(), (w + 7) / 8, h, comp.data());
  printf("cpp compress  %.2f ms\n", ms(t) / N);
  t = clk::now(); for (int i = 0; i < N; i++) bplz::base64Encode(rgba.data(), 100000, b64.data());
  printf("cpp base64 100KB %.3f ms\n", ms(t) / N);
}
