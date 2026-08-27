// FILE: ProjectSidebarIcon.tsx
// Purpose: Render the standard project folder icon with an optional favicon badge overlay.
// Layer: Sidebar UI component
// Exports: ProjectSidebarIcon

import { useEffect, useState } from "react";

import { useMediaAuthToken } from "~/hooks/useMediaAuthToken";
import { resolveMediaHttpUrl } from "~/lib/mediaAssetUrls";
import { createMediaProbeCache } from "~/lib/mediaProbeCache";
import { FolderClosed, FolderOpen } from "./FolderClosed";

// Keyed by project, not by favicon URL: on the mobile shell the URL carries a rotating
// credential, and a cache keyed on it would both re-probe and grow without bound. "No favicon"
// is remembered only for the credential that observed it, so a 401 from a probe that ran before
// the credential arrived does not seed an absent badge for the rest of the session.
const projectFaviconPresence = createMediaProbeCache<boolean>((present) => present === false);

function resolveProjectFaviconUrl(cwd: string): string {
  const params = new URLSearchParams({ cwd, fallback: "none" });
  return resolveMediaHttpUrl(`/api/project-favicon?${params.toString()}`);
}

export function ProjectSidebarIcon({
  cwd,
  expanded,
  glyphClassName: glyphClassNameProp,
}: {
  cwd: string;
  expanded: boolean;
  glyphClassName?: string;
}) {
  const glyphClassName = glyphClassNameProp ?? "size-4";
  // Subscribed, not just read: when the media credential rotates the previous URL stops working,
  // so this component has to rebuild its src rather than wait for an unrelated re-render.
  useMediaAuthToken();
  const faviconSrc = resolveProjectFaviconUrl(cwd);
  // Keyed by cwd: a cwd change derives back to the cache-seeded default in the
  // same render, so the probe effect never needs a synchronous setState.
  const [probe, setProbe] = useState<{ cwd: string; present: boolean } | null>(() => {
    const cached = projectFaviconPresence.get(cwd);
    return cached === undefined ? null : { cwd, present: cached };
  });
  const hasFavicon = probe !== null && probe.cwd === cwd && probe.present;
  const FolderGlyph = expanded ? FolderOpen : FolderClosed;

  // Probe with Image() so Electron/file-origin behaves like the actual visible
  // <img>. Runs even on a module-cache hit (the browser cache makes the reload
  // instant) so the load/error handlers stay the only state writers.
  useEffect(() => {
    let cancelled = false;
    const image = new Image();
    const handleLoad = () => {
      projectFaviconPresence.set(cwd, true);
      if (!cancelled) {
        setProbe({ cwd, present: true });
      }
    };
    const handleError = () => {
      projectFaviconPresence.set(cwd, false);
      if (!cancelled) {
        setProbe({ cwd, present: false });
      }
    };

    image.addEventListener("load", handleLoad);
    image.addEventListener("error", handleError);

    image.src = faviconSrc;

    return () => {
      cancelled = true;
      image.removeEventListener("load", handleLoad);
      image.removeEventListener("error", handleError);
    };
  }, [cwd, faviconSrc]);

  return (
    <>
      <FolderGlyph className={glyphClassName} />
      {hasFavicon ? (
        <img
          src={faviconSrc}
          alt=""
          aria-hidden="true"
          className="absolute -right-1 -bottom-1 size-3 rounded-[4px] object-contain shadow-sm"
          onError={() => {
            projectFaviconPresence.set(cwd, false);
            setProbe({ cwd, present: false });
          }}
        />
      ) : null}
    </>
  );
}
