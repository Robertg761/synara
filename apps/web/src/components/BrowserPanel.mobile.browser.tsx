import "../index.css";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThreadId, type NativeApi, type MobileBrowserPlugin, type ThreadBrowserState } from "@synara/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { createMobileBrowserApi } from "../mobileBrowser";
import { handleMobileBack } from "../lib/mobileBackStack";

vi.mock("../env", () => ({ isElectron: false, isMobileShell: true, isNativeShell: true }));
let api: NativeApi;
vi.mock("../nativeApi", () => ({ readNativeApi: () => api, ensureNativeApi: () => api }));
import BrowserPanel from "./BrowserPanel";

afterEach(async () => { await page.viewport(1280, 800); });

it.each([
  { width: 320, height: 700 }, { width: 393, height: 700 },
  { width: 412, height: 700 }, { width: 732, height: 364 },
].flatMap((viewport) => [
  { ...viewport, mode: "sidebar" as const },
  { ...viewport, mode: "sheet" as const },
]))("keeps native $mode browser controls reachable at $width x $height", async ({ width, height, mode }) => {
  await page.viewport(width, height);
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
      <div data-browser-test-container style={{ width: "100%", height: height - 30, display: "flex" }}>
        <BrowserPanel mode={mode} threadId={threadId} onClosePanel={() => {}} />
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
  const panel = document.querySelector<HTMLElement>("[data-browser-test-container]")!;
  const inputRect = panel.querySelector("input")!.getBoundingClientRect();
  expect(inputRect.width).toBeGreaterThanOrEqual(64);
  for (const control of panel.querySelectorAll<HTMLElement>("button, input")) {
    const rect = control.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(width);
    expect(rect.bottom).toBeLessThanOrEqual(height);
  }

  if (matchMedia("(pointer: coarse)").matches) {
    const closeTab = screen.getByRole("button", { name: "Close tab", exact: true }).element() as HTMLElement;
    const closeRect = closeTab.getBoundingClientRect();
    expect(closeRect.width).toBeGreaterThanOrEqual(44);
    expect(closeRect.height).toBeGreaterThanOrEqual(44);
    for (const offset of [-20, 20]) {
      expect(closeTab.contains(document.elementFromPoint(closeRect.left + closeRect.width / 2 + offset, closeRect.top + closeRect.height / 2))).toBe(true);
    }
    const copyLink = screen.getByRole("button", { name: "Copy link", exact: true }).element() as HTMLElement;
    const rect = copyLink.getBoundingClientRect();
    for (const offset of [-20, 20]) {
      expect(copyLink.contains(document.elementFromPoint(rect.left + rect.width / 2 + offset, rect.top + rect.height / 2))).toBe(true);
    }
  }
  const originalBounds = lastBounds() as { y: number; height: number };
  const tabsBottom = screen.getByRole("button", { name: "New tab", exact: true }).element().getBoundingClientRect().bottom;
  expect(originalBounds.y).toBeGreaterThanOrEqual(tabsBottom);
  const panelHeight = panel.getBoundingClientRect().height;
  panel.style.height = `${panelHeight - 50}px`;
  await vi.waitFor(() => expect((lastBounds() as { height: number }).height).toBeLessThan(originalBounds.height));
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
