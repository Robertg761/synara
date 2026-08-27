// FILE: QrCode.tsx
// Purpose: Renders a value as an inline SVG QR code (pairing links, connection URLs).
// Layer: UI component

import { useMemo } from "react";
import { encode } from "uqr";

import { cn } from "~/lib/utils";

export function QrCode({
  value,
  label,
  className,
}: {
  value: string;
  /** Accessible description of what scanning the code opens. */
  label: string;
  className?: string;
}) {
  const path = useMemo(() => {
    const { data, size } = encode(value, { ecc: "M", border: 2 });
    let d = "";
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (data[y]?.[x]) d += `M${x} ${y}h1v1h-1z`;
      }
    }
    return { d, size };
  }, [value]);

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${path.size} ${path.size}`}
      // Quiet-zone contrast must not follow the app theme: scanners need dark
      // modules on a light background.
      className={cn("size-40 rounded-lg bg-white p-1", className)}
      shapeRendering="crispEdges"
    >
      <path d={path.d} fill="#111" />
    </svg>
  );
}
