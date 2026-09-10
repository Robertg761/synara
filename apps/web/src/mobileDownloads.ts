// Export the same bytes desktop downloads through Android's system share sheet.
const EXPORT_ROOT = "synara-exports";
const CHUNK_BYTES = 512 * 1024;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function mobileExportFilename(filename: string): string {
  return filename.trim().replace(/[/\\\u0000-\u001f]/g, "_").slice(0, 180) || "download";
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 32_768));
  }
  return btoa(binary);
}

export async function clearExpiredMobileExports(now = Date.now()): Promise<void> {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  const entries = await Filesystem.readdir({ path: EXPORT_ROOT, directory: Directory.Cache })
    .catch(() => ({ files: [] }));
  for (const entry of entries.files) {
    if (now - entry.mtime < MAX_AGE_MS) continue;
    await Filesystem.rmdir({
      path: `${EXPORT_ROOT}/${entry.name}`, directory: Directory.Cache, recursive: true,
    }).catch(() => {});
  }
}

export async function shareMobileBlob(blob: Blob, filename: string): Promise<void> {
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([
    import("@capacitor/filesystem"), import("@capacitor/share"),
  ]);
  await clearExpiredMobileExports();
  const folder = `${EXPORT_ROOT}/${crypto.randomUUID()}`;
  const path = `${folder}/${mobileExportFilename(filename)}`;
  try {
    // Base64 is bounded to one chunk, not a second full-size copy of a large attachment.
    await Filesystem.writeFile({ path, directory: Directory.Cache, data: "", recursive: true });
    for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
      const bytes = new Uint8Array(await blob.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
      await Filesystem.appendFile({ path, directory: Directory.Cache, data: base64(bytes) });
    }
    const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
    await Share.share({ files: [uri], title: filename, dialogTitle: "Save or share file" });
    // The recipient may still be reading after the chooser closes. Expire on a later launch.
  } catch (error) {
    await Filesystem.rmdir({ path: folder, directory: Directory.Cache, recursive: true }).catch(() => {});
    throw error;
  }
}
