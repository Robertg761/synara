import "../../index.css";

import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ChatHeader } from "./ChatHeader";
import { createMinimalChatHeaderProps } from "./chatHeaderTestFixtures";
import { SidebarProvider } from "../ui/sidebar";
import { PhonePaneScreen } from "../phone/PhonePaneScreen";
import { selectRightDockState, useRightDockStore } from "../../rightDockStore";
import { resolveActivePane } from "../../rightDockStore.logic";

const props = createMinimalChatHeaderProps();
afterEach(async () => {
  useRightDockStore.getState().clearThreadDockState(props.activeThreadId);
  await page.viewport(1280, 800);
});

it("opens the browser pushed screen from a 44px phone header button", async () => {
  await page.viewport(412, 844);
  function Harness() {
    const dock = useRightDockStore(selectRightDockState(props.activeThreadId));
    const pane = resolveActivePane(dock);
    return <SidebarProvider>
      <div inert={dock.open && pane !== null} style={{ width: "100%" }}>
        <ChatHeader {...props} hideSidebarControls onToggleBrowser={() => {
          useRightDockStore.getState().toggleSingletonPane(props.activeThreadId, { kind: "browser" });
        }} />
      </div>
      {dock.open && pane ? <PhonePaneScreen pane={pane} title="Browser" runtimeMode="live"
        onClose={() => useRightDockStore.getState().closePane(props.activeThreadId, pane.id)}
        renderPane={() => <div>Browser test page</div>} /> : null}
    </SidebarProvider>;
  }
  const screen = await render(<Harness />);
  const button = screen.getByRole("button", { name: "Open browser", exact: true });
  await expect.element(button).toBeVisible();
  const rect = document.querySelector<HTMLElement>('[aria-label="Open browser"]')!.getBoundingClientRect();
  expect(rect.width).toBeGreaterThanOrEqual(44);
  expect(rect.height).toBeGreaterThanOrEqual(44);
  await button.click();
  await expect.element(screen.getByRole("region", { name: "Browser", exact: true })).toBeVisible();
  expect(useRightDockStore.getState().dockStateByThreadId[props.activeThreadId]?.panes[0]?.kind).toBe("browser");
  await screen.getByRole("button", { name: "Close Browser", exact: true }).click();
  await expect.element(button).toBeVisible();
  await screen.unmount();
});
