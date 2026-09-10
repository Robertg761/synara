import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  writeFile: vi.fn().mockResolvedValue({ uri: "file:///cache/export" }),
  appendFile: vi.fn().mockResolvedValue(undefined),
  getUri: vi.fn().mockResolvedValue({ uri: "file:///cache/export" }),
  rmdir: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue({ files: [] }),
  share: vi.fn().mockResolvedValue({}),
}));
vi.mock("@capacitor/filesystem", () => ({ Filesystem: native, Directory: { Cache: "CACHE" } }));
vi.mock("@capacitor/share", () => ({ Share: { share: native.share } }));

import { clearExpiredMobileExports, mobileExportFilename, shareMobileBlob } from "./mobileDownloads";

beforeEach(() => {
  vi.clearAllMocks();
  native.readdir.mockResolvedValue({ files: [] });
});

describe("native file export", () => {
  it("preserves binary bytes across bounded bridge writes", async () => {
    const bytes = Uint8Array.from({ length: 1_100_017 }, (_, index) => index % 256);
    await shareMobileBlob(new Blob([bytes]), "image.bin");
    const decoded = native.appendFile.mock.calls.map(([call]) => Buffer.from(call.data, "base64"));
    expect(Buffer.concat(decoded)).toEqual(Buffer.from(bytes));
    expect(decoded.every((chunk) => chunk.length <= 512 * 1024)).toBe(true);
    expect(native.share).toHaveBeenCalledWith({
      files: ["file:///cache/export"], title: "image.bin", dialogTitle: "Save or share file",
    });
    expect(native.rmdir).not.toHaveBeenCalled();
  });

  it("does not share incomplete files and removes them on write failure", async () => {
    native.appendFile.mockRejectedValueOnce(new Error("disk full"));
    await expect(shareMobileBlob(new Blob(["secret"]), "notes.txt")).rejects.toThrow("disk full");
    expect(native.share).not.toHaveBeenCalled();
    expect(native.rmdir).toHaveBeenCalledOnce();
  });

  it("expires old exports without deleting a recipient's fresh file", async () => {
    const now = 100_000_000;
    native.readdir.mockResolvedValue({ files: [
      { name: "old", mtime: now - 86_400_001 },
      { name: "fresh", mtime: now },
    ] });
    await clearExpiredMobileExports(now);
    expect(native.rmdir).toHaveBeenCalledExactlyOnceWith({
      path: "synara-exports/old", directory: "CACHE", recursive: true,
    });
  });

  it("keeps export names inside the allocated cache directory", () => {
    expect(mobileExportFilename("../secret\\notes.txt")).toBe(".._secret_notes.txt");
    expect(mobileExportFilename(" ")).toBe("download");
    expect(mobileExportFilename("a".repeat(300))).toHaveLength(180);
  });
});
