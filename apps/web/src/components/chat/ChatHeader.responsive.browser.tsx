import "../../index.css";

import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { SidebarProvider } from "../ui/sidebar";
import { IconButton } from "../ui/icon-button";
import { PHONE_HEADER_ICON_BUTTON_CLASS } from "../phone/phoneChrome";
import { ChatHeader } from "./ChatHeader";
import { createMinimalChatHeaderProps } from "./chatHeaderTestFixtures";

const viewports = [
  { width: 320, height: 700 }, { width: 393, height: 700 },
  { width: 412, height: 700 }, { width: 732, height: 364 },
];
afterEach(async () => {
  delete document.documentElement.dataset.layout;
  await page.viewport(1280, 800);
});

it.each(viewports)("keeps long-title header actions reachable at $width x $height", async ({ width, height }) => {
  await page.viewport(width, height);
  document.documentElement.dataset.layout = "phone";
  const browser = vi.fn();
  const environment = vi.fn();
  const diff = vi.fn();
  const screen = await render(
    <SidebarProvider>
      <ChatHeader {...createMinimalChatHeaderProps()}
        activeThreadTitle={"Long unbroken title ".repeat(20)}
        hideSidebarControls
        leadingControl={<IconButton label="Back to chats" className={PHONE_HEADER_ICON_BUTTON_CLASS}>←</IconButton>}
        onToggleBrowser={browser}
        onToggleDiff={diff}
        showDiffToggle
        isGitRepo
        diffTotals={{ additions: 123456, deletions: 234567, fileCount: 987, hasChanges: true }}
        environment={{ open: false, onOpenChange: environment }}
      />
    </SidebarProvider>,
  );
  for (const label of ["Back to chats", "Open browser", "Toggle environment panel", "Toggle diff panel"]) {
    const button = screen.getByRole("button", { name: label, exact: true });
    const node = button.element() as HTMLElement;
    const rect = node.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(width);
    expect(rect.bottom).toBeLessThanOrEqual(height);
    expect(node.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))).toBe(true);
    await button.click();
  }
  expect(browser).toHaveBeenCalledOnce();
  expect(environment).toHaveBeenCalledOnce();
  expect(diff).toHaveBeenCalledOnce();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  await screen.unmount();
});
