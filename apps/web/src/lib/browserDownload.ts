// FILE: browserDownload.ts
// Purpose: Browser-side file download helpers that keep failed downloads inside the app.
// Layer: Web utility
// Exports: downloadBlob, downloadUrlAsBlob, downloadServerFileAsBlob
// Depends on: DOM anchor downloads, Fetch, and ./authenticatedFetch for server routes.

import { authenticatedServerFetch } from "./authenticatedFetch";

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename.trim() || "download";
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

const MAX_ERROR_DETAIL_CHARS = 300;

// Routes like /api/thread-export return a human-readable reason in the body
// (e.g. 409 while a turn is running); surface it instead of the bare status.
async function downloadResponseError(response: Response): Promise<Error> {
  const statusText = response.statusText ? ` ${response.statusText}` : "";
  let detail = "";
  try {
    detail = (await response.text()).trim();
  } catch {
    detail = "";
  }
  const suffix = detail.length > 0 && detail.length <= MAX_ERROR_DETAIL_CHARS ? ` ${detail}` : "";
  return new Error(`Download failed with HTTP ${response.status}${statusText}.${suffix}`);
}

function filenameFromContentDisposition(headerValue: string | null): string | null {
  if (!headerValue) return null;

  const match = /(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(headerValue);
  const filename = (match?.[1] ?? match?.[2] ?? "").trim();
  return filename.length > 0 ? filename : null;
}

async function saveResponseAsDownload(response: Response, fallbackFilename: string): Promise<void> {
  if (!response.ok) {
    throw await downloadResponseError(response);
  }
  const filename = filenameFromContentDisposition(response.headers.get("Content-Disposition"));
  downloadBlob(await response.blob(), filename ?? fallbackFilename);
}

// Fetches a local artifact before saving it so server 404/auth errors cannot
// navigate the main Electron renderer away from the app.
export async function downloadUrlAsBlob(input: {
  readonly url: string;
  readonly filename: string;
}): Promise<void> {
  await saveResponseAsDownload(await fetch(input.url), input.filename);
}

/**
 * The same download, for a server route that requires a real session rather than the read-only
 * media credential — thread export, whose payload is a whole transcript. Because the client
 * fetches the bytes itself it can carry the bearer in a header, which is the entire reason such a
 * route need not (and must not) accept a credential from the URL.
 */
export async function downloadServerFileAsBlob(input: {
  readonly path: string;
  readonly filename: string;
}): Promise<void> {
  await saveResponseAsDownload(await authenticatedServerFetch(input.path), input.filename);
}
