#include "HybridBplzCodec.hpp"

#include <cmath>
#include <stdexcept>
#include <string>
#include <vector>

#include "bplz_core.hpp"

namespace margelo::nitro::bplzlabel {

namespace {

constexpr size_t kMaxDimension = 32000;

size_t toDimension(double value, const char* name) {
  if (!(value >= 1) || value > kMaxDimension || std::floor(value) != value) {
    throw std::invalid_argument(std::string(name) + " must be an integer from 1 to 32000");
  }
  return static_cast<size_t>(value);
}

bplz::Method toMethod(DitherMethod method) {
  switch (method) {
    case DitherMethod::THRESHOLD:
      return bplz::Method::Threshold;
    case DitherMethod::FLOYD_STEINBERG:
      return bplz::Method::FloydSteinberg;
    case DitherMethod::ATKINSON:
      return bplz::Method::Atkinson;
    case DitherMethod::BAYER:
      return bplz::Method::Bayer;
  }
  throw std::invalid_argument("Unknown dither method");
}

// A buffer that comes from JS is only valid during this call. The work runs later on another
// thread, so the bytes are copied first.
std::vector<uint8_t> copyBytes(const std::shared_ptr<ArrayBuffer>& buffer) {
  return std::vector<uint8_t>(buffer->data(), buffer->data() + buffer->size());
}

}  // namespace

std::shared_ptr<Promise<std::shared_ptr<ArrayBuffer>>> HybridBplzCodec::ditherRgba(
    const std::shared_ptr<ArrayBuffer>& rgba, double width, double height, DitherMethod method, double threshold,
    bool invert) {
  const size_t w = toDimension(width, "width");
  const size_t h = toDimension(height, "height");
  if (rgba->size() < w * h * 4) throw std::invalid_argument("rgba is shorter than width * height * 4");
  const bplz::Method m = toMethod(method);
  const int t = static_cast<int>(threshold);
  auto input = copyBytes(rgba);
  return Promise<std::shared_ptr<ArrayBuffer>>::async([input = std::move(input), w, h, m, t, invert]() {
    std::vector<uint8_t> gray(w * h);
    bplz::grayFromRgba(input.data(), w, h, gray.data());
    std::vector<uint8_t> bits(((w + 7) >> 3) * h, 0);
    bplz::dither(gray.data(), w, h, m, t, invert, bits.data());
    return ArrayBuffer::move(std::move(bits));
  });
}

std::shared_ptr<Promise<std::shared_ptr<ArrayBuffer>>> HybridBplzCodec::ditherGray(
    const std::shared_ptr<ArrayBuffer>& gray, double width, double height, DitherMethod method, double threshold,
    bool invert) {
  const size_t w = toDimension(width, "width");
  const size_t h = toDimension(height, "height");
  if (gray->size() < w * h) throw std::invalid_argument("gray is shorter than width * height");
  const bplz::Method m = toMethod(method);
  const int t = static_cast<int>(threshold);
  auto input = copyBytes(gray);
  return Promise<std::shared_ptr<ArrayBuffer>>::async([input = std::move(input), w, h, m, t, invert]() {
    std::vector<uint8_t> bits(((w + 7) >> 3) * h, 0);
    bplz::dither(input.data(), w, h, m, t, invert, bits.data());
    return ArrayBuffer::move(std::move(bits));
  });
}

std::shared_ptr<Promise<std::shared_ptr<ArrayBuffer>>> HybridBplzCodec::zplCompress(
    const std::shared_ptr<ArrayBuffer>& bitmap, double bytesPerRow) {
  const size_t bpr = toDimension(bytesPerRow, "bytesPerRow");
  auto input = copyBytes(bitmap);
  return Promise<std::shared_ptr<ArrayBuffer>>::async([input = std::move(input), bpr]() {
    const size_t rows = input.size() / bpr;
    std::vector<uint8_t> out(input.size() * 2 + rows + 16);
    out.resize(bplz::zplCompress(input.data(), bpr, rows, out.data()));
    return ArrayBuffer::move(std::move(out));
  });
}

std::string HybridBplzCodec::base64Encode(const std::shared_ptr<ArrayBuffer>& data) {
  std::string out(((data->size() + 2) / 3) * 4, '\0');
  const size_t n = bplz::base64Encode(data->data(), data->size(), reinterpret_cast<uint8_t*>(out.data()));
  out.resize(n);
  return out;
}

}  // namespace margelo::nitro::bplzlabel
