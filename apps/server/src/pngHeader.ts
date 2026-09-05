// FILE: pngHeader.ts
// Purpose: Read a PNG's pixel dimensions out of its own header.
// Layer: Server utility
// Exports: pngDimensions
//
// One reader for both capture families. The device backend and the computer
// backends each grew their own byte-level IHDR parse — same offsets, same magic,
// two hand-written signature comparisons — and the two had already diverged on
// whether a zero dimension is "no dimensions" or "invalid dimensions". They keep
// their own *policies* (the device path treats a bad header as "not an image and
// carry on"; the computer path throws a message naming the backend, because that
// message is what a tool call and an availability card both end up showing), and
// share the parse.

/** `\x89PNG\r\n\x1a\n`, the eight bytes every conformant file opens with. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
/** "IHDR", the first chunk's type, at a fixed offset in every conformant file. */
const PNG_IHDR = [0x49, 0x48, 0x44, 0x52] as const;
/** Signature, length, chunk type, then width and height: nothing before byte 24. */
const PNG_HEADER_BYTES = 24;

export interface PngDimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * Width and height from the IHDR chunk, or `null` for anything that is not a
 * PNG whose header declares a non-empty image.
 *
 * Reading them from the encoding rather than assuming the requested size is
 * what keeps a capture's `scale` honest: a backend renders at the output's
 * device pixel ratio and only then downscales to its budget.
 */
export function pngDimensions(bytes: Uint8Array): PngDimensions | null {
  if (bytes.byteLength < PNG_HEADER_BYTES) return null;
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return null;
  if (!PNG_IHDR.every((byte, index) => bytes[12 + index] === byte)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}
