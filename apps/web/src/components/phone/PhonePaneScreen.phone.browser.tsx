// FILE: PhonePaneScreen.phone.browser.tsx
// Purpose: Browser regression for the phone pushed pane screen — it covers the whole phone
//          viewport, hands the pane to the host's dock renderer as the active/visible surface,
//          mounts no <Sidebar>/Sheet (the trap the desktop dock falls into below 768px), and
//          closes from a comfortable touch target.
// Layer: Phone layout UI test
// Depends on: ~/test/browserHarness (phone viewport + fullscreen host).

import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { RightDockPane } from "~/rightDockStore.logic";
import { PHONE_VIEWPORT, renderAtPhoneViewport } from "~/test/browserHarness";
import { PhonePaneScreen } from "./PhonePaneScreen";

/** Minimum comfortable touch target, in CSS pixels. */
const TOUCH_TARGET_MIN_PX = 44;

const TERMINAL_PANE: RightDockPane = {
  id: "pane-terminal",
  kind: "terminal",
  threadId: null,
  diffTurnId: null,
  diffFilePath: null,
  filePath: null,
  pullRequestProjectId: null,
  pullRequestRepository: null,
  pullRequestNumber: null,
  pullRequestInitialTab: null,
};

describe("PhonePaneScreen", () => {
  let host: HTMLDivElement | null = null;

  afterEach(() => {
    if (host?.isConnected) host.remove();
    host = null;
  });

  it("fills the phone viewport and renders the pane live, with no sidebar shell", async () => {
    host = await renderAtPhoneViewport();
    const renderPane = vi.fn(() => <div data-testid="pane-body">terminal</div>);

    const screen = await render(
      <PhonePaneScreen
        pane={TERMINAL_PANE}
        title="Terminal"
        runtimeMode="live"
        onClose={() => {}}
        renderPane={renderPane}
      />,
      { container: host },
    );

    try {
      await expect.element(screen.getByTestId("pane-body")).toBeVisible();
      // The host renderer is the same callback the desktop dock uses; the pushed screen
      // is always the one active, visible pane.
      expect(renderPane).toHaveBeenCalledWith(TERMINAL_PANE, {
        runtimeMode: "live",
        isActive: true,
        isVisible: true,
      });

      const surface = document.querySelector<HTMLElement>("[data-phone-pane-screen]");
      expect(surface).not.toBeNull();
      const bounds = surface?.getBoundingClientRect();
      expect(Math.round(bounds?.width ?? 0)).toBe(PHONE_VIEWPORT.width);
      expect(Math.round(bounds?.height ?? 0)).toBe(PHONE_VIEWPORT.height);

      // The trap this screen exists to dodge: the right dock is a nested <Sidebar>, which
      // becomes a Sheet under 768px. The phone pane surface must mount neither.
      expect(document.querySelector('[data-slot="sidebar"]')).toBeNull();
      expect(document.querySelector('[data-slot="sidebar-container"]')).toBeNull();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("closes from a comfortable touch target", async () => {
    host = await renderAtPhoneViewport();
    const onClose = vi.fn();

    const screen = await render(
      <PhonePaneScreen
        pane={TERMINAL_PANE}
        title="Terminal"
        runtimeMode="live"
        onClose={onClose}
        renderPane={() => null}
      />,
      { container: host },
    );

    try {
      const closeButton = screen.getByRole("button", { name: "Close Terminal" });
      await expect.element(closeButton).toBeVisible();
      const bounds = (closeButton.element() as HTMLElement).getBoundingClientRect();
      expect(bounds.width).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
      expect(bounds.height).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);

      await closeButton.click();
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });
});
