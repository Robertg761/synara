#include "image.h"

#include <stdlib.h>
#include <string.h>

#define STB_IMAGE_WRITE_IMPLEMENTATION
#define STBIW_ASSERT(x) ((void)0)
#include "../third_party/stb_image_write.h"

/*
 * wl_shm's two historical formats have small enum values; every other format is
 * its DRM fourcc. The 32-bit packed formats are what a GPU renderer hands to a
 * shm screencopy client; the two 24-bit RGB formats are what the pixman
 * software renderer offers (headless sway, VMs, GPU-less fallback desktops —
 * proven by the live headless-sway lane, whose only offer is BGR888). Anything
 * else — 16-bit, 10-bit, planar — stays a refusal, because a half-decoded
 * buffer would be a corrupt screenshot rather than an honest sentence.
 */
#define WL_SHM_FORMAT_ARGB8888 0
#define WL_SHM_FORMAT_XRGB8888 1
#define FOURCC(a, b, c, d) ((uint32_t)(a) | ((uint32_t)(b) << 8) | ((uint32_t)(c) << 16) | ((uint32_t)(d) << 24))
#define WL_SHM_FORMAT_XBGR8888 FOURCC('X', 'B', '2', '4')
#define WL_SHM_FORMAT_ABGR8888 FOURCC('A', 'B', '2', '4')
#define WL_SHM_FORMAT_RGBX8888 FOURCC('R', 'X', '2', '4')
#define WL_SHM_FORMAT_RGBA8888 FOURCC('R', 'A', '2', '4')
#define WL_SHM_FORMAT_BGRX8888 FOURCC('B', 'X', '2', '4')
#define WL_SHM_FORMAT_BGRA8888 FOURCC('B', 'A', '2', '4')
#define WL_SHM_FORMAT_RGB888 FOURCC('R', 'G', '2', '4')
#define WL_SHM_FORMAT_BGR888 FOURCC('B', 'G', '2', '4')

bool image_alloc(image_rgba *image, uint32_t width, uint32_t height) {
	image->pixels = NULL;
	image->width = 0;
	image->height = 0;
	if (width == 0 || height == 0) return false;
	/* Guards the multiply below on 32-bit size_t as much as it guards absurd
	 * requests: 16384x16384 RGBA is already a gigabyte. */
	if (width > IMAGE_MAX_DIMENSION || height > IMAGE_MAX_DIMENSION) return false;
	if ((uint64_t)width * (uint64_t)height > IMAGE_MAX_PIXELS) return false;
	size_t bytes = (size_t)width * (size_t)height * 4;
	uint8_t *pixels = calloc(1, bytes);
	if (pixels == NULL) return false;
	image->pixels = pixels;
	image->width = width;
	image->height = height;
	return true;
}

void image_free(image_rgba *image) {
	free(image->pixels);
	image->pixels = NULL;
	image->width = 0;
	image->height = 0;
}

/*
 * Bytes per pixel and the byte offsets of red, green and blue inside one
 * little-endian pixel. DRM fourcc channel order reads high-to-low bit, so the
 * bytes in memory run in the opposite order to the name: RGB888's memory bytes
 * are B,G,R and BGR888's are R,G,B.
 */
static bool format_layout(uint32_t format, int *bytes_per_pixel, int *red, int *green, int *blue) {
	switch (format) {
	case WL_SHM_FORMAT_ARGB8888:
	case WL_SHM_FORMAT_XRGB8888:
		*bytes_per_pixel = 4;
		*red = 2;
		*green = 1;
		*blue = 0;
		return true;
	case WL_SHM_FORMAT_XBGR8888:
	case WL_SHM_FORMAT_ABGR8888:
		*bytes_per_pixel = 4;
		*red = 0;
		*green = 1;
		*blue = 2;
		return true;
	case WL_SHM_FORMAT_RGBX8888:
	case WL_SHM_FORMAT_RGBA8888:
		*bytes_per_pixel = 4;
		*red = 3;
		*green = 2;
		*blue = 1;
		return true;
	case WL_SHM_FORMAT_BGRX8888:
	case WL_SHM_FORMAT_BGRA8888:
		*bytes_per_pixel = 4;
		*red = 1;
		*green = 2;
		*blue = 3;
		return true;
	case WL_SHM_FORMAT_RGB888:
		*bytes_per_pixel = 3;
		*red = 2;
		*green = 1;
		*blue = 0;
		return true;
	case WL_SHM_FORMAT_BGR888:
		*bytes_per_pixel = 3;
		*red = 0;
		*green = 1;
		*blue = 2;
		return true;
	default:
		return false;
	}
}

bool image_format_supported(uint32_t wl_shm_format) {
	int bytes_per_pixel = 0;
	int red = 0;
	int green = 0;
	int blue = 0;
	return format_layout(wl_shm_format, &bytes_per_pixel, &red, &green, &blue);
}

const char *image_format_name(uint32_t wl_shm_format) {
	switch (wl_shm_format) {
	case WL_SHM_FORMAT_ARGB8888: return "ARGB8888";
	case WL_SHM_FORMAT_XRGB8888: return "XRGB8888";
	case WL_SHM_FORMAT_XBGR8888: return "XBGR8888";
	case WL_SHM_FORMAT_ABGR8888: return "ABGR8888";
	case WL_SHM_FORMAT_RGBX8888: return "RGBX8888";
	case WL_SHM_FORMAT_RGBA8888: return "RGBA8888";
	case WL_SHM_FORMAT_BGRX8888: return "BGRX8888";
	case WL_SHM_FORMAT_BGRA8888: return "BGRA8888";
	case WL_SHM_FORMAT_RGB888: return "RGB888";
	case WL_SHM_FORMAT_BGR888: return "BGR888";
	default: return "an unrecognised wl_shm format";
	}
}

bool image_from_shm(image_rgba *out, const uint8_t *source, uint32_t width, uint32_t height,
                    uint32_t stride, uint32_t wl_shm_format, bool y_invert) {
	int bytes_per_pixel = 0;
	int red = 0;
	int green = 0;
	int blue = 0;
	if (!format_layout(wl_shm_format, &bytes_per_pixel, &red, &green, &blue)) return false;
	if ((uint64_t)stride < (uint64_t)width * (uint64_t)bytes_per_pixel) return false;
	if (!image_alloc(out, width, height)) return false;
	for (uint32_t row = 0; row < height; row++) {
		uint32_t source_row = y_invert ? height - 1 - row : row;
		const uint8_t *in = source + (size_t)source_row * stride;
		uint8_t *dst = out->pixels + (size_t)row * width * 4;
		for (uint32_t column = 0; column < width; column++) {
			const uint8_t *pixel = in + (size_t)column * (size_t)bytes_per_pixel;
			dst[0] = pixel[red];
			dst[1] = pixel[green];
			dst[2] = pixel[blue];
			/* Opaque on purpose: a screen has no transparency, and passing an
			 * X channel through as alpha produces a PNG that renders as noise. */
			dst[3] = 0xFF;
			dst += 4;
		}
	}
	return true;
}

/*
 * One resampler for both directions. Each destination pixel averages the source
 * rectangle that maps onto it, which is a box filter when shrinking and
 * degenerates to nearest-neighbour when growing.
 */
static void resample_into(uint8_t *destination, size_t destination_stride, uint32_t destination_width,
                          uint32_t destination_height, const image_rgba *source) {
	for (uint32_t y = 0; y < destination_height; y++) {
		double source_y0 = (double)y * source->height / destination_height;
		double source_y1 = (double)(y + 1) * source->height / destination_height;
		uint32_t y0 = (uint32_t)source_y0;
		uint32_t y1 = (uint32_t)source_y1;
		if (y1 <= y0) y1 = y0 + 1;
		if (y1 > source->height) y1 = source->height;
		uint8_t *row = destination + (size_t)y * destination_stride;
		for (uint32_t x = 0; x < destination_width; x++) {
			double source_x0 = (double)x * source->width / destination_width;
			double source_x1 = (double)(x + 1) * source->width / destination_width;
			uint32_t x0 = (uint32_t)source_x0;
			uint32_t x1 = (uint32_t)source_x1;
			if (x1 <= x0) x1 = x0 + 1;
			if (x1 > source->width) x1 = source->width;
			/* 64-bit because one destination pixel can cover the whole source: a
			 * `maxDimension: 1` capture of a 5120x2880 desktop sums fifteen
			 * million channel bytes, four times what a uint32 holds. */
			uint64_t red = 0;
			uint64_t green = 0;
			uint64_t blue = 0;
			uint64_t count = 0;
			for (uint32_t sy = y0; sy < y1; sy++) {
				const uint8_t *pixel = source->pixels + ((size_t)sy * source->width + x0) * 4;
				for (uint32_t sx = x0; sx < x1; sx++) {
					red += pixel[0];
					green += pixel[1];
					blue += pixel[2];
					count++;
					pixel += 4;
				}
			}
			uint8_t *out = row + (size_t)x * 4;
			if (count == 0) count = 1;
			out[0] = (uint8_t)(red / count);
			out[1] = (uint8_t)(green / count);
			out[2] = (uint8_t)(blue / count);
			out[3] = 0xFF;
		}
	}
}

bool image_blit_resampled(image_rgba *destination, int32_t x, int32_t y, uint32_t width,
                          uint32_t height, const image_rgba *source) {
	if (width == 0 || height == 0 || source->pixels == NULL) return false;
	if (x < 0 || y < 0) return false;
	if ((uint32_t)x >= destination->width || (uint32_t)y >= destination->height) return false;
	/* Rounding the destination rect can push it a pixel past the edge; clipping
	 * here rather than refusing keeps a multi-output capture from failing on a
	 * rounding artefact. */
	if ((uint32_t)x + width > destination->width) width = destination->width - (uint32_t)x;
	if ((uint32_t)y + height > destination->height) height = destination->height - (uint32_t)y;
	uint8_t *corner = destination->pixels + ((size_t)y * destination->width + (uint32_t)x) * 4;
	resample_into(corner, (size_t)destination->width * 4, width, height, source);
	return true;
}

bool image_fit_within(image_rgba *image, uint32_t max_dimension) {
	if (max_dimension == 0 || image->pixels == NULL) return false;
	uint32_t longest = image->width > image->height ? image->width : image->height;
	if (longest <= max_dimension) return true;
	double factor = (double)max_dimension / (double)longest;
	uint32_t width = (uint32_t)(image->width * factor);
	uint32_t height = (uint32_t)(image->height * factor);
	if (width == 0) width = 1;
	if (height == 0) height = 1;
	image_rgba scaled;
	if (!image_alloc(&scaled, width, height)) return false;
	resample_into(scaled.pixels, (size_t)width * 4, width, height, image);
	image_free(image);
	*image = scaled;
	return true;
}

typedef struct {
	uint8_t *bytes;
	size_t length;
	size_t capacity;
	bool failed;
} png_sink;

static void png_write(void *context, void *data, int size) {
	png_sink *sink = context;
	if (sink->failed || size <= 0) return;
	if (sink->length + (size_t)size > sink->capacity) {
		size_t capacity = sink->capacity == 0 ? 64 * 1024 : sink->capacity;
		while (capacity < sink->length + (size_t)size) capacity *= 2;
		uint8_t *bytes = realloc(sink->bytes, capacity);
		if (bytes == NULL) {
			sink->failed = true;
			return;
		}
		sink->bytes = bytes;
		sink->capacity = capacity;
	}
	memcpy(sink->bytes + sink->length, data, (size_t)size);
	sink->length += (size_t)size;
}

bool image_encode_png(const image_rgba *image, uint8_t **bytes, size_t *length) {
	if (image->pixels == NULL) return false;
	png_sink sink = {.bytes = NULL, .length = 0, .capacity = 0, .failed = false};
	/* Level 6 is where stb's deflate stops paying for itself on screen content;
	 * the still-frame poll runs twice a second and CPU is the scarce resource. */
	stbi_write_png_compression_level = 6;
	int ok = stbi_write_png_to_func(png_write, &sink, (int)image->width, (int)image->height, 4,
	                                image->pixels, (int)(image->width * 4));
	if (ok == 0 || sink.failed || sink.length == 0) {
		free(sink.bytes);
		return false;
	}
	*bytes = sink.bytes;
	*length = sink.length;
	return true;
}
