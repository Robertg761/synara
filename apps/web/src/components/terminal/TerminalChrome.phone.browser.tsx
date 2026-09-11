import "../../index.css";

import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

vi.mock("../../env", () => ({ isMobileShell: true, isElectron: false, isNativeShell: true }));
import { TerminalSidebar, TerminalWorkspaceTabBar } from "./TerminalChrome";

const viewports = [
  { width: 320, height: 700 }, { width: 393, height: 700 },
  { width: 412, height: 700 }, { width: 732, height: 364 },
];
afterEach(async () => { await page.viewport(1280, 800); });

it.each(viewports.flatMap((viewport) => [
  { ...viewport, sidebar: false }, { ...viewport, sidebar: true },
]))("keeps terminal actions separate at $width x $height (sidebar=$sidebar)", async ({ width, height, sidebar }) => {
  await page.viewport(width, height);
  const create = vi.fn();
  const split = vi.fn();
  const actions = [
    { label: "New terminal", onClick: create, children: "+" },
    { label: "Split terminal", onClick: split, children: "|" },
  ];
  const screen = await render(sidebar ? (
    <TerminalSidebar terminalIds={[]} terminalGroups={[]} activeTerminalId="none" activeGroupId="none"
      showGroupHeaders={false} terminalVisualIdentityById={new Map()} actions={actions}
      onActiveTerminalChange={vi.fn()} onCloseTerminal={vi.fn()} />
  ) : (
    <TerminalWorkspaceTabBar terminalGroups={[]} activeGroupId="none"
      terminalVisualIdentityById={new Map()} actions={actions}
      onActiveGroupChange={vi.fn()} onCloseGroup={vi.fn()} />
  ));
  for (const label of ["New terminal", "Split terminal"]) {
    const button = screen.getByRole("button", { name: label, exact: true });
    const node = button.element() as HTMLElement;
    const rect = node.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(width);
    for (const offset of [-20, 20]) {
      expect(node.contains(document.elementFromPoint(rect.left + rect.width / 2 + offset, rect.top + rect.height / 2))).toBe(true);
    }
    await button.click();
  }
  expect(create).toHaveBeenCalledOnce();
  expect(split).toHaveBeenCalledOnce();
  await screen.unmount();
});
