// FILE: SiteFavicon.tsx
// Purpose: Render a website's favicon for a URL, falling back to the globe icon
//          while loading and on failure (no layout shift). Probes with Image()
//          so behavior matches the actual visible <img>, and shares a module-level
//          status cache so a known host renders immediately on re-render.
// Layer: Shared UI component
// Used by: markdown source links (ChatMarkdown), InlineLinkChip (composer + user bubble).

import { useEffect, useState } from "react";

import { useMediaAuthToken } from "~/hooks/useMediaAuthToken";
import { GlobeIcon } from "~/lib/icons";
import {
  extractHostname,
  probeSiteFavicon,
  resolveSiteFaviconUrl,
  siteFaviconCacheKey,
  siteFaviconStatusCache,
} from "~/lib/siteFavicon";
import { cn } from "~/lib/utils";

export interface SiteFaviconProps {
  /** Full URL (or bare host) the favicon should represent. */
  readonly url: string;
  /** Square px size for both the favicon and the globe fallback. Omit to size via `className`. */
  readonly size?: number | undefined;
  readonly className?: string | undefined;
}

export const SiteFavicon = function SiteFavicon({ url, size, className }: SiteFaviconProps) {
  // Rebuild the src when the mobile shell's media credential rotates; a no-op everywhere else.
  useMediaAuthToken();
  const host = extractHostname(url) ?? (url.includes(".") ? url : null);
  const faviconSrc = host ? resolveSiteFaviconUrl(host) : null;
  // Keyed by the site, not the src: a host change derives back to the pending/fallback state in
  // the same render (so the probe effect never sets state synchronously), while a credential
  // rotation — which changes the src but not the site — keeps the icon on screen.
  const faviconKey = faviconSrc === null ? null : siteFaviconCacheKey(faviconSrc);

  // Seed from the shared cache so a known host renders its icon immediately.
  const [probe, setProbe] = useState<{ key: string; status: "ok" | "fail" } | null>(() => {
    if (faviconKey === null) return null;
    const cached = siteFaviconStatusCache.get(faviconKey);
    return cached === undefined ? null : { key: faviconKey, status: cached };
  });
  const status: "ok" | "fail" | null =
    faviconKey === null ? "fail" : probe !== null && probe.key === faviconKey ? probe.status : null;

  // Probe with Image() (via the shared, de-duped helper) so Electron/file-origin
  // behaves like the visible <img> and every consumer reuses one load per host.
  useEffect(() => {
    if (faviconSrc === null || faviconKey === null) {
      return;
    }
    let cancelled = false;
    void probeSiteFavicon(faviconSrc).then((result) => {
      if (!cancelled) setProbe({ key: faviconKey, status: result });
    });
    return () => {
      cancelled = true;
    };
  }, [faviconSrc, faviconKey]);

  const sizeStyle = size === undefined ? undefined : { width: `${size}px`, height: `${size}px` };

  if (status === "ok" && faviconSrc) {
    return (
      <img
        src={faviconSrc}
        alt=""
        aria-hidden="true"
        className={cn("shrink-0 rounded-[2px] object-contain", className)}
        style={sizeStyle}
        onError={() => {
          if (faviconKey === null) return;
          siteFaviconStatusCache.set(faviconKey, "fail");
          setProbe({ key: faviconKey, status: "fail" });
        }}
      />
    );
  }

  return <GlobeIcon aria-hidden="true" className={className} style={sizeStyle} />;
};
