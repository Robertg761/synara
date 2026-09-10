import "../index.css";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThreadId, type NativeApi, type MobileBrowserPlugin, type ThreadBrowserState } from "@synara/contracts";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { createMobileBrowserApi } from "../mobileBrowser";
import { handleMobileBack } from "../lib/mobileBackStack";

vi.mock("../env", () => ({ isElectron: false, isMobileShell: true, isNativeShell: true }));
let api: NativeApi;
vi.mock("../nativeApi", () => ({ readNativeApi: () => api, ensureNativeApi: () => api }));
import BrowserPanel from "./BrowserPanel";

it("shows native controls and hides the guest while a shared dialog is open", async () => {
  const threadId = ThreadId.makeUnsafe("mobile-browser-panel");
  const snapshot: ThreadBrowserState = {
    threadId, version: 1, open: true, activeTabId: "tab", lastError: null,
    tabs: [{ id: "tab", url: "https://example.com", title: "Example", runtimeSurface: "native",
      status: "live", isLoading: false, canGoBack: true, canGoForward: false,
      faviconUrl: null, lastCommittedUrl: "https://example.com", lastError: null }],
  };
  const execute = vi.fn<MobileBrowserPlugin["execute"]>(async () => snapshot);
  api = { browser: createMobileBrowserApi({ execute, addListener: async () => ({ remove: async () => {} }) }) } as NativeApi;
  const client = new QueryClient();
  function Harness() {
    const [open, setOpen] = useState(false);
    return <QueryClientProvider client={client}>
      <button onClick={() => setOpen(true)}>Open test dialog</button>
      <div data-browser-test-container style={{ width: 390, height: 700, display: "flex" }}>
        <BrowserPanel mode="sheet" threadId={threadId} onClosePanel={() => {}} />
      </div>
      {open ? <div role="dialog" aria-modal="true" data-slot="dialog-popup" style={{ position: "fixed", inset: 0, zIndex: 100, background: "white" }}>
        <button onClick={() => setOpen(false)}>Close test dialog</button>
      </div> : null}
    </QueryClientProvider>;
  }
  const screen = await render(<Harness />);
  const lastBounds = () => execute.mock.calls.map(([input]) => input as { operation: string; input: { bounds?: unknown } })
    .filter((call) => call.operation === "setPanelBounds").at(-1)?.input.bounds;
  await vi.waitFor(() => expect(lastBounds()).toEqual(expect.objectContaining({ width: expect.any(Number) })));
  await expect.element(screen.getByRole("button", { name: "Copy screenshot", exact: true })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Reload", exact: true })).toBeEnabled();
  await screen.getByRole("button", { name: "Open test dialog" }).click();
  await vi.waitFor(() => expect(lastBounds()).toBeNull());
  await screen.getByRole("button", { name: "Close test dialog" }).click();
  await vi.waitFor(() => expect(lastBounds()).toEqual(expect.objectContaining({ width: expect.any(Number) })));
  expect(document.querySelector("webview")).toBeNull();
  const goBack = vi.fn();
  const container = document.querySelector<HTMLElement>("[data-browser-test-container]")!;
  container.style.display = "none";
  expect(handleMobileBack({ canGoBack: () => true, goBack })).toBe("navigated");
  expect(goBack).toHaveBeenCalledOnce();
  await screen.unmount();
  client.clear();
});
