import "../index.css";

import type { BrowserTabState } from "@synara/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { BrowserTabStrip } from "./BrowserTabStrip";

const tabs: BrowserTabState[] = Array.from({ length: 6 }, (_, index) => ({
  id: `tab-${index}`,
  title: `Repository ${index} with a very long page title`,
  url: `https://example.com/${index}`,
  runtimeSurface: "native",
  status: "live",
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
  faviconUrl: null,
  lastCommittedUrl: `https://example.com/${index}`,
  lastError: null,
}));
afterEach(async () => { await page.viewport(1280, 800); });

it("keeps every tab and New tab reachable in the 320px touch strip", async () => {
  await page.viewport(320, 700);
  const select = vi.fn();
  const create = vi.fn();
  const screen = await render(<BrowserTabStrip tabs={tabs} activeTabId="tab-0" status={null}
    dragRegion={false} touchControls onSelectTab={select} onCloseTab={vi.fn()} onCreateTab={create} />);
  for (const tab of tabs) {
    await screen.getByRole("button", { name: tab.title, exact: true }).click();
    expect(select).toHaveBeenLastCalledWith(tab.id);
  }
  const lastTab = screen.getByRole("button", { name: tabs[5]!.title }).element() as HTMLElement;
  expect(lastTab.getBoundingClientRect().right).toBeLessThanOrEqual(320);
  await screen.getByRole("button", { name: "New tab", exact: true }).click();
  expect(create).toHaveBeenCalledOnce();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320);
  await screen.unmount();
});
