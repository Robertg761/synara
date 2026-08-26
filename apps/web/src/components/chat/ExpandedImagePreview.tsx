// FILE: ExpandedImagePreview.tsx
// Purpose: Shapes the lightbox payload for a set of message image attachments.
// Layer: Chat UI logic

import { withCurrentMediaCredential } from "~/lib/mediaAssetUrls";

export interface ExpandedImageItem {
  src: string;
  name: string;
}

export interface ExpandedImagePreview {
  images: ExpandedImageItem[];
  index: number;
}

export function buildExpandedImagePreview(
  images: ReadonlyArray<{ id: string; name: string; previewUrl?: string }>,
  selectedImageId: string,
): ExpandedImagePreview | null {
  const previewableImages = images.flatMap((image) =>
    // Built when the lightbox opens, from a store URL that carries no credential of its own.
    image.previewUrl
      ? [{ id: image.id, src: withCurrentMediaCredential(image.previewUrl), name: image.name }]
      : [],
  );
  if (previewableImages.length === 0) {
    return null;
  }
  const selectedIndex = previewableImages.findIndex((image) => image.id === selectedImageId);
  if (selectedIndex < 0) {
    return null;
  }
  return {
    images: previewableImages.map((image) => ({
      src: image.src,
      name: image.name,
    })),
    index: selectedIndex,
  };
}
