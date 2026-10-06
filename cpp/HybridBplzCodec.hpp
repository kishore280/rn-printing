#pragma once

#include "HybridBplzCodecSpec.hpp"

namespace margelo::nitro::bplzlabel {

/** C++ implementation of the codec. The loops are in bplz_core.cpp. */
class HybridBplzCodec final : public HybridBplzCodecSpec {
 public:
  HybridBplzCodec() : HybridObject(TAG) {}

 public:
  std::shared_ptr<Promise<std::shared_ptr<ArrayBuffer>>> ditherRgba(const std::shared_ptr<ArrayBuffer>& rgba,
                                                                    double width, double height, DitherMethod method,
                                                                    double threshold, bool invert) override;
  std::shared_ptr<Promise<std::shared_ptr<ArrayBuffer>>> ditherGray(const std::shared_ptr<ArrayBuffer>& gray,
                                                                    double width, double height, DitherMethod method,
                                                                    double threshold, bool invert) override;
  std::shared_ptr<Promise<std::shared_ptr<ArrayBuffer>>> zplCompress(const std::shared_ptr<ArrayBuffer>& bitmap,
                                                                     double bytesPerRow) override;
  std::string base64Encode(const std::shared_ptr<ArrayBuffer>& data) override;
};

}  // namespace margelo::nitro::bplzlabel
