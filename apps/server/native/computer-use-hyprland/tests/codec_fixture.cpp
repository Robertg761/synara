// The capture encoders against the real codec libraries, with no compositor:
// the production bodies are spliced in and their output decoded back, so a
// format, a MIME type or a channel order that is wrong fails here rather than
// in the server's image pipeline.
#include <bit>
#include <cairo/cairo.h>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <format>
#include <iostream>
#include <stdexcept>
#include <string>
#include <turbojpeg.h>
#include <vector>

[[noreturn]] void captureFailed(const std::string& message) { throw std::runtime_error(message); }
void check(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

// PRODUCTION_DEFINITIONS

// A surface filled with one premultiplied ARGB32 pixel value.
cairo_surface_t* filled(int w, int h, uint32_t argb) {
    cairo_surface_t* surface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, w, h);
    unsigned char*   data    = cairo_image_surface_get_data(surface);
    const int        stride  = cairo_image_surface_get_stride(surface);
    for (int y = 0; y < h; ++y)
        for (int x = 0; x < w; ++x)
            reinterpret_cast<uint32_t*>(data + y * stride)[x] = argb;
    cairo_surface_mark_dirty(surface);
    return surface;
}

// Decodes a JPEG to RGB, checking its size.
std::vector<uint8_t> decodeJpeg(const std::vector<uint8_t>& jpeg, int w, int h) {
    tjhandle tj = tj3Init(TJINIT_DECOMPRESS);
    check(tj3DecompressHeader(tj, jpeg.data(), jpeg.size()) == 0, "JPEG header unreadable");
    check(tj3Get(tj, TJPARAM_JPEGWIDTH) == w && tj3Get(tj, TJPARAM_JPEGHEIGHT) == h, "JPEG has the wrong size");
    std::vector<uint8_t> rgb(size_t(w) * h * 3);
    check(tj3Decompress8(tj, jpeg.data(), jpeg.size(), rgb.data(), 0, TJPF_RGB) == 0, "JPEG does not decode");
    tj3Destroy(tj);
    return rgb;
}

int main() {
    check(captureFormat(0) == CaptureFormat::Png && captureFormat(CAPTURE_FLAG_PASSIVE) == CaptureFormat::Png, "PNG is not the default format");
    check(captureFormat(CAPTURE_FLAG_JPEG) == CaptureFormat::Jpeg, "JPEG flag ignored");
    check(captureFormat(CAPTURE_FLAG_JPEG | CAPTURE_FLAG_LUMA) == CaptureFormat::Luma, "luma does not outrank JPEG");

    // Luma: BT.601 weights, one byte per pixel, rows without padding. The
    // 5-pixel width makes cairo's stride differ from the output row.
    {
        cairo_surface_t* surface = filled(5, 3, 0xff'ff'00'00); // opaque red
        auto*            data    = cairo_image_surface_get_data(surface);
        reinterpret_cast<uint32_t*>(data + cairo_image_surface_get_stride(surface))[4] = 0xff'ff'ff'ff; // white at (4, 1)
        reinterpret_cast<uint32_t*>(data)[1] = 0x00'00'00'00;                                              // transparent at (1, 0)
        cairo_surface_mark_dirty(surface);
        const SEncodedImage image = encodeCaptureImage(surface, CaptureFormat::Luma);
        check(image.mime == "image/x-luma8; width=5; height=3", "luma MIME type wrong");
        check(image.bytes.size() == 15, "luma image padded");
        check(image.bytes[0] == 77 && image.bytes[1] == 0 && image.bytes[5 + 4] == 255, "luma values wrong");
        cairo_surface_destroy(surface);
    }

    // JPEG: decodes at the right size with the right colours, including the
    // channel order of cairo's native-endian words.
    {
        cairo_surface_t*    surface = filled(33, 17, 0xff'20'80'e0);
        const SEncodedImage image   = encodeCaptureImage(surface, CaptureFormat::Jpeg);
        check(image.mime == "image/jpeg", "JPEG MIME type wrong");
        check(image.bytes.size() > 2 && image.bytes[0] == 0xff && image.bytes[1] == 0xd8, "not a JPEG stream");
        const auto rgb = decodeJpeg(image.bytes, 33, 17);
        for (size_t i = 0; i < rgb.size(); i += 3)
            check(std::abs(rgb[i] - 0x20) < 8 && std::abs(rgb[i + 1] - 0x80) < 8 && std::abs(rgb[i + 2] - 0xe0) < 8, "JPEG colours wrong");
        cairo_surface_destroy(surface);
    }

    std::cout << "Capture encoders produce the declared formats, sizes and colours.\n";
}
