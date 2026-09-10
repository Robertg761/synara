import { ThreadId, type MobileBrowserPlugin } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMobileBrowserApi } from "./mobileBrowser";

const threadId = ThreadId.makeUnsafe("browser-thread");
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const execute = vi.fn<MobileBrowserPlugin["execute"]>().mockResolvedValue({});
  const remove = vi.fn(async () => {});
  const addListener = vi.fn<MobileBrowserPlugin["addListener"]>().mockResolvedValue({ remove });
  return { api: createMobileBrowserApi({ execute, addListener }), execute, addListener, remove };
}

describe("Android browser adapter", () => {
  it("uses native navigation and passes viewport geometry without credentials", async () => {
    vi.stubGlobal("window", { innerWidth: 390 });
    const { api, execute } = fixture();
    await api.navigate({ threadId, url: "https://example.com" });
    expect(execute).toHaveBeenLastCalledWith({ operation: "navigate", input: { threadId, url: "https://example.com" } });
    const bounds = { x: 0, y: 80, width: 390, height: 600 };
    await api.setPanelBounds({ threadId, bounds, surface: "native" });
    expect(execute).toHaveBeenLastCalledWith({ operation: "setPanelBounds", input: { threadId, bounds, surface: "native", viewportWidth: 390 } });
    expect(api.capabilities).toEqual({ embeddedPreview: true, captureScreenshot: true, copyScreenshot: false, annotations: false });
  });

  it("decodes native screenshot bytes for the existing composer attachment path", async () => {
    const { api, execute } = fixture();
    execute.mockResolvedValue({ name: "capture.png", base64: "iVBORw==" });
    const result = await api.captureScreenshot({ threadId, tabId: "tab" });
    expect(result).toEqual({ name: "capture.png", mimeType: "image/png", sizeBytes: 4, bytes: new Uint8Array([137, 80, 78, 71]) });
  });

  it("removes a listener that registers after the panel unmounts", async () => {
    const { api, addListener, remove } = fixture();
    let finish: ((handle: { remove: typeof remove }) => void) | undefined;
    addListener.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const listener = vi.fn();
    const stop = api.onState(listener);
    stop();
    finish!({ remove });
    await Promise.resolve();
    expect(remove).toHaveBeenCalledOnce();
    addListener.mock.calls[0]![1]({ threadId, version: 1, open: false, activeTabId: null, tabs: [], lastError: null });
    expect(listener).not.toHaveBeenCalled();
  });
});
