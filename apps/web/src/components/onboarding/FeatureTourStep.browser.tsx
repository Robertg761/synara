import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { FeatureTourStep } from "../../onboarding/steps/FeatureTourStep";
import { TOUR_CARDS } from "../../onboarding/tourContent";

const client = new QueryClient();
afterEach(async () => {
  client.clear();
  await page.viewport(1280, 800);
});

async function mountTour(width: number) {
  await page.viewport(width, 844);
  return render(
    <QueryClientProvider client={client}>
      <div style={{ width: "calc(100vw - 32px)", maxWidth: 800, height: 360, padding: 32, boxSizing: "border-box", display: "flex", overflowY: "auto" }}>
        <FeatureTourStep />
      </div>
    </QueryClientProvider>,
  );
}

it("puts scrollable topics above a readable full-width article on phones", async () => {
  const screen = await mountTour(412);
  const tabs = document.querySelector<HTMLElement>('[role="tablist"]')!;
  const panel = document.querySelector<HTMLElement>('[role="tabpanel"]')!;
  const tabRect = tabs.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  expect(panelRect.top).toBeGreaterThanOrEqual(tabRect.bottom);
  expect(panelRect.width).toBeGreaterThan(300);
  expect(Math.abs(panelRect.width - tabRect.width)).toBeLessThan(1);
  expect(tabs.scrollWidth).toBeGreaterThan(tabs.clientWidth);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(412);
  const lastCard = TOUR_CARDS.find((card) => card.id === "browser") ?? TOUR_CARDS[2]!;
  await screen.getByRole("tab", { name: lastCard.label, exact: true }).click();
  await expect.element(screen.getByRole("heading", { name: lastCard.title })).toBeVisible();
  await expect.element(screen.getByRole("tab", { name: lastCard.label, exact: true })).toHaveAttribute("aria-selected", "true");
  expect(tabs.getBoundingClientRect().height).toBeLessThan(60);
  await screen.unmount();
});

it("preserves the 220px vertical topic list and adjacent article on desktop", async () => {
  const screen = await mountTour(1280);
  const tabs = document.querySelector<HTMLElement>('[role="tablist"]')!.getBoundingClientRect();
  const panel = document.querySelector<HTMLElement>('[role="tabpanel"]')!.getBoundingClientRect();
  expect(tabs.width).toBe(220);
  expect(panel.left).toBeGreaterThan(tabs.right);
  expect(Math.abs(panel.top - tabs.top)).toBeLessThan(1);
  expect(panel.width).toBeGreaterThan(450);
  expect(tabs.height).toBeGreaterThan(200);
  await screen.unmount();
});
