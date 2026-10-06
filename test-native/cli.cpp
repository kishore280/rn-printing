// Test helper. Reads bytes on stdin, writes the result on stdout.
//   cli dither <method 0-3> <w> <h> <threshold> <invert>   (stdin: RGBA)
//   cli zplc <bytesPerRow>                                  (stdin: packed bitmap)
//   cli b64                                                 (stdin: any bytes)
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <iterator>
#include <string>
#include <vector>
#include "../cpp/bplz_core.hpp"

int main(int argc, char** argv) {
  std::vector<uint8_t> in((std::istreambuf_iterator<char>(std::cin)), std::istreambuf_iterator<char>());
  std::vector<uint8_t> out;
  std::string op = argc > 1 ? argv[1] : "";
  if (op == "dither" && argc == 7) {
    const int m = atoi(argv[2]);
    const size_t w = atoi(argv[3]), h = atoi(argv[4]);
    std::vector<uint8_t> gray(w * h);
    bplz::grayFromRgba(in.data(), w, h, gray.data());
    out.assign(((w + 7) >> 3) * h, 0);
    bplz::dither(gray.data(), w, h, static_cast<bplz::Method>(m), atoi(argv[5]), atoi(argv[6]) != 0, out.data());
  } else if (op == "zplc" && argc == 3) {
    const size_t bpr = atoi(argv[2]);
    const size_t rows = in.size() / bpr;
    out.resize(in.size() * 2 + rows + 16);
    out.resize(bplz::zplCompress(in.data(), bpr, rows, out.data()));
  } else if (op == "b64") {
    out.resize(((in.size() + 2) / 3) * 4);
    out.resize(bplz::base64Encode(in.data(), in.size(), out.data()));
  } else {
    return 2;
  }
  fwrite(out.data(), 1, out.size(), stdout);
  return 0;
}
