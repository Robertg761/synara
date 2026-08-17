/*
 * Pixels between a compositor's shm buffer and a PNG.
 *
 * Three things happen here and nowhere else: the shm format is normalised to
 * straight RGBA, the per-output captures are composited into one desktop-space
 * image, and that image is resampled down to the caller's `maxDimension`.
 * Doing the crop and the downscale here rather than in TypeScript is what keeps
 * a 5120x2520 desktop from being base64'd across a pipe at full size twice a
 * second.
 */
#ifndef SYNARA_HELPER_IMAGE_H
#define SYNARA_HELPER_IMAGE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/** The widest or tallest image this helper will allocate, in pixels. */
#define IMAGE_MAX_DIMENSION 32768
/**
 * The most pixels one image may hold, whatever its shape. stb's PNG writer does
 * its size arithmetic in `int`, so a buffer this side accepted but that side
 * cannot count would wrap somewhere inside the encoder.
 */
#define IMAGE_MAX_PIXELS (256u * 1024u * 1024u)

typedef struct {
	uint32_t width;
	uint32_t height;
	uint8_t *pixels; /* width * height * 4, straight RGBA */
} image_rgba;

bool image_alloc(image_rgba *image, uint32_t width, uint32_t height);
void image_free(image_rgba *image);

/** Whether this helper can read a wl_shm format at all, by its wl_shm value. */
bool image_format_supported(uint32_t wl_shm_format);
/** The name a refusal quotes for an unsupported format. */
const char *image_format_name(uint32_t wl_shm_format);

/**
 * Converts one captured shm buffer into RGBA, flipping it when the compositor
 * reported the frame as bottom-up (`y_invert`).
 */
bool image_from_shm(image_rgba *out, const uint8_t *source, uint32_t width, uint32_t height,
                    uint32_t stride, uint32_t wl_shm_format, bool y_invert);

/**
 * Area-averages `source` into the `destination` rect. Averaging rather than
 * sampling matters because the common case is a downscale of text, where
 * nearest-neighbour drops whole strokes and makes a screenshot unreadable.
 *
 * False means nothing was drawn because the rect lies outside the destination.
 * The caller has to say so: a dropped contribution is one monitor's worth of
 * black in an otherwise plausible screenshot, which is worse than a refusal.
 */
bool image_blit_resampled(image_rgba *destination, int32_t x, int32_t y, uint32_t width,
                          uint32_t height, const image_rgba *source);

/** Fits an image inside `max_dimension`, in place. A smaller image is untouched. */
bool image_fit_within(image_rgba *image, uint32_t max_dimension);

/** Encodes RGBA as PNG. The caller owns and frees `bytes`. */
bool image_encode_png(const image_rgba *image, uint8_t **bytes, size_t *length);

#endif
