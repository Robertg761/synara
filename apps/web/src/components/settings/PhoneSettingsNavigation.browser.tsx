import "../../index.css";

import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { SETTINGS_NAV_ITEMS, type SettingsSectionId } from "../../settingsNavigation";
import { handleMobileBack } from "../../lib/mobileBackStack";
import { PhoneSettingsNavigation } from "./PhoneSettingsNavigation";

afterEach(async () => { await page.viewport(1280, 800); });

it("makes every settings section and search target reachable on a phone", async () => {
  await page.viewport(412, 844);
  const select = vi.fn();
  const back = vi.fn();
  function Harness() {
    const [section, setSection] = useState<SettingsSectionId>("general");
    return <div style={{ padding: 24 }}><PhoneSettingsNavigation
      activeSection={section}
      onBack={back}
      onSelectSection={(next, options) => { setSection(next); select(next, options); }}
    /></div>;
  }
  const screen = await render(<Harness />);
  const toggle = screen.getByRole("button", { name: "Choose settings section" });
  for (const item of SETTINGS_NAV_ITEMS) {
    await toggle.click();
    await screen.getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: item.label, exact: true }).click();
    expect(select).toHaveBeenLastCalledWith(item.id, undefined);
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    await expect.element(toggle).toHaveTextContent(`Settings: ${item.label}`);
  }
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(412);
  await toggle.click();
  await screen.getByRole("textbox", { name: "Search settings" }).fill("Theme");
  await screen.getByRole("button", { name: "Theme", exact: true }).click();
  expect(select).toHaveBeenLastCalledWith("appearance", { target: "setting-theme" });
  await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  expect(handleMobileBack({ canGoBack: () => false, goBack: vi.fn() })).toBe("dismissed");
  await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await screen.getByRole("button", { name: "Back to app" }).click();
  expect(back).toHaveBeenCalledOnce();
  await screen.unmount();
});

it("leaves desktop settings navigation to the existing sidebar", async () => {
  await page.viewport(1280, 800);
  const screen = await render(<PhoneSettingsNavigation activeSection="general" onBack={vi.fn()} onSelectSection={vi.fn()} />);
  await expect.element(screen.getByRole("button", { name: "Choose settings section" })).not.toBeInTheDocument();
  await screen.unmount();
});
