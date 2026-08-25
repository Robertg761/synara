// FILE: browserDownload.test.ts
// Purpose: Verifies blob-backed downloads do not fall back to top-level navigation on failures.
// Layer: Web utility tests
// Depends on: browserDownload helpers with mocked Fetch and DOM anchor APIs.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { downloadServerFileAsBlob, downloadUrlAsBlob } from "./browserDownload";

// The server-route download goes through `authenticatedServerFetch`; these stand in for the
// runtime it asks about. The credential rules themselves are covered in authenticatedFetch.test.
vi.mock("../env", () => ({ isMobileShell: true, isNativeShell: true, isElectron: false }));
vi.mock("../shellAuthSession", () => ({
  acquireShellBearerToken: () => Promise.resolve("shell-bearer"),
  invalidateShellBearerToken: () => {},
}));
vi.mock("../shellSessionExit", () => ({ handleShellSessionRevoked: () => Promise.resolve() }));
vi.mock("./serverEndpoint", () => ({
  resolveWsHttpUrl: (path: string) => `http://192.168.1.5:3773${path}`,
}));

describe("browserDownload", () => {
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  let click: ReturnType<typeof vi.fn>;
  let appended: unknown[] = [];
  let link: {
    href: string;
    download: string;
    click: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    click = vi.fn();
    appended = [];
    link = {
      href: "",
      download: "",
      click,
      remove: vi.fn(),
    };
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        createElement: vi.fn((tagName: string) => {
          if (tagName !== "a") throw new Error(`Unexpected element ${tagName}`);
          return link;
        }),
        body: {
          appendChild: vi.fn((node: unknown) => {
            appended.push(node);
            return node;
          }),
        },
      },
    });
    URL.createObjectURL = vi.fn(() => "blob:download");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
    globalThis.fetch = originalFetch;
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  it("falls back to the caller filename when Content-Disposition is absent", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response("<svg />", { status: 200 })));

    await downloadUrlAsBlob({
      url: "http://127.0.0.1:5733/api/local-image?download=1",
      filename: "favicon.svg",
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:5733/api/local-image?download=1",
    );
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(link.href).toBe("blob:download");
    expect(link.download).toBe("favicon.svg");
    expect(appended).toEqual([link]);
    expect(click).toHaveBeenCalledTimes(1);
    expect(link.remove).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:download");
  });

  it("prefers the server filename from Content-Disposition", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response("zip", {
          status: 200,
          headers: { "Content-Disposition": 'attachment; filename="synara-thread-pretty.zip"' },
        }),
      ),
    );

    await downloadUrlAsBlob({
      url: "http://127.0.0.1:5733/api/thread-export?threadId=thread-1",
      filename: "synara-thread-thread-1.zip",
    });

    expect(link.download).toBe("synara-thread-pretty.zip");
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("falls back to the caller filename when Content-Disposition is malformed", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response("zip", {
          status: 200,
          headers: { "Content-Disposition": "attachment; filename=" },
        }),
      ),
    );

    await downloadUrlAsBlob({
      url: "http://127.0.0.1:5733/api/thread-export?threadId=thread-1",
      filename: "synara-thread-thread-1.zip",
    });

    expect(link.download).toBe("synara-thread-thread-1.zip");
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("surfaces the response body reason when the server blocks the download", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response("Thread is still running. Wait for the current turn to finish.", {
          status: 409,
          statusText: "Conflict",
        }),
      ),
    );

    await expect(
      downloadUrlAsBlob({
        url: "http://127.0.0.1:5733/api/thread-export?threadId=thread-1",
        filename: "synara-thread-thread-1.zip",
      }),
    ).rejects.toThrow(
      "Download failed with HTTP 409 Conflict. Thread is still running. Wait for the current turn to finish.",
    );

    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it("throws before creating a download when the server rejects the file", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response("Not Found", { status: 404, statusText: "Not Found" })),
    );

    await expect(
      downloadUrlAsBlob({
        url: "http://127.0.0.1:5733/api/local-image?download=1",
        filename: "favicon.ico",
      }),
    ).rejects.toThrow("Download failed with HTTP 404 Not Found.");

    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it("carries the shell session in a header for a server-route download", async () => {
    // The transcript archive is fetched, not navigated to, which is precisely why it can hold its
    // credential in a header — and why the route need not accept the replayable media one.
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response("zip", {
          status: 200,
          headers: { "Content-Disposition": 'attachment; filename="synara-thread-1.zip"' },
        }),
      ),
    );

    await downloadServerFileAsBlob({
      path: "/api/thread-export?threadId=thread-1",
      filename: "synara-thread-thread-1.zip",
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://192.168.1.5:3773/api/thread-export?threadId=thread-1",
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer shell-bearer" },
      }),
    );
    expect(link.download).toBe("synara-thread-1.zip");
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("surfaces a rejected server-route download instead of saving it", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response("Unauthorized", { status: 401, statusText: "Unauthorized" })),
    );

    await expect(
      downloadServerFileAsBlob({
        path: "/api/thread-export?threadId=thread-1",
        filename: "synara-thread-thread-1.zip",
      }),
    ).rejects.toThrow("Download failed with HTTP 401 Unauthorized.");

    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });
});
