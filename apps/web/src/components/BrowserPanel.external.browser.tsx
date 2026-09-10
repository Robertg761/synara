// Verifies the browser fallback offers a working action without desktop-only controls.
import "../index.css";

import { ThreadId, type NativeApi } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

let api: NativeApi;
vi.mock("../nativeApi", () => ({
  readNativeApi: () => api,
  ensureNativeApi: () => api,
}));
vi.mock("../wsTransport", () => ({
  WsTransport: class {
    subscribe() {
      return () => {};
    }
    onStateChange() {
      return () => {};
    }
    onCompatibilityIssue() {
      return () => {};
    }
    onThreadStreamFailure() {
      return () => {};
    }
    getState() {
      return "open";
    }
    getLatestPush() {
      return null;
    }
  },
}));

import BrowserPanel from "./BrowserPanel";
import { createWsNativeApi } from "../wsNativeApi";

it("opens the selected URL externally and disables unavailable capture actions", async () => {
  api = createWsNativeApi();
  const openExternal = vi.spyOn(api.shell, "openExternal").mockResolvedValue();
  const threadId = ThreadId.makeUnsafe("external-browser-test");
  await api.browser.open({ threadId, initialUrl: "https://example.com/page" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={client}>
      <div style={{ width: 390, height: 700, display: "flex" }}>
        <BrowserPanel mode="sheet" threadId={threadId} onClosePanel={() => {}} />
      </div>
    </QueryClientProvider>,
  );

  await expect.element(screen.getByRole("button", { name: "Open in browser", exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Copy screenshot", exact: true })).toBeDisabled();
  await screen.getByRole("button", { name: "Open in browser", exact: true }).click();
  expect(openExternal).toHaveBeenCalledWith("https://example.com/page");
  expect(document.querySelector("webview")).toBeNull();
  await screen.unmount();
  client.clear();
});
