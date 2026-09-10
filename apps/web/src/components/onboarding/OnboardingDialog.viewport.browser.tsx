import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { OnboardingDialog } from "../../onboarding/OnboardingDialog";

vi.mock("../../appSettings", () => ({
  useAppSettings: () => ({ settings: { disabledProviders: [] } }),
}));
vi.mock("../../hooks/useProviderStatusesForLocalConfig", () => ({
  useProviderStatusesForLocalConfig: () => [],
}));
vi.mock("../../hooks/useTheme", () => ({
  useTheme: () => ({ activeTheme: { codeThemeId: "github-dark" } }),
}));
// Setup integrations are outside this geometry regression; the welcome/tour,
// dialog frame, navigation and footer are the production components.
vi.mock("../../onboarding/steps/ProvidersStep", () => ({ ProvidersStep: () => null }));
vi.mock("../../onboarding/steps/ThemeStep", () => ({ ThemeStep: () => null }));
vi.mock("../../onboarding/steps/ProjectStep", () => ({ ProjectStep: () => null }));

const clients: QueryClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.clear();
  await page.viewport(1280, 800);
});

it.each([
  { name: "short landscape", width: 732, height: 364, popupHeight: 332 },
  { name: "portrait bottom sheet", width: 412, height: 700, popupHeight: 540 },
  { name: "short portrait bottom sheet", width: 412, height: 500, popupHeight: 452 },
  { name: "desktop", width: 1280, height: 800, popupHeight: 540 },
])("keeps onboarding navigation reachable in $name", async ({ width, height, popupHeight }) => {
  await page.viewport(width, height);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const screen = await render(
    <QueryClientProvider client={client}>
      <OnboardingDialog open onOpenChange={() => {}} onComplete={() => {}} />
    </QueryClientProvider>,
  );
  const assertFrame = () => {
    const popup = document.querySelector<HTMLElement>('[data-slot="dialog-popup"]')!;
    const rect = popup.getBoundingClientRect();
    expect(rect.height).toBeCloseTo(popupHeight, 0);
    expect(rect.top).toBeGreaterThanOrEqual(width < 640 ? 48 : 16);
    expect(rect.bottom).toBeLessThanOrEqual(height - (width < 640 ? 0 : 16));
    const footer = popup.querySelector<HTMLElement>('[data-slot="dialog-footer"]')!;
    const footerRect = footer.getBoundingClientRect();
    expect(footerRect.bottom).toBeLessThanOrEqual(rect.bottom);
    const primary = footer.querySelectorAll('button');
    const button = primary[primary.length - 1]!;
    const buttonRect = button.getBoundingClientRect();
    expect(button.contains(document.elementFromPoint(
      buttonRect.left + buttonRect.width / 2,
      buttonRect.top + buttonRect.height / 2,
    ))).toBe(true);
  };
  await expect.poll(() => document.querySelector('[data-slot="dialog-popup"]')?.getBoundingClientRect().height).toBeCloseTo(popupHeight, 0);
  assertFrame();
  await screen.getByRole("button", { name: "Get started", exact: true }).click();
  await expect.element(screen.getByRole("button", { name: "Set up", exact: true })).toBeVisible();
  assertFrame();
  if (height === 364) {
    const body = document.querySelector<HTMLElement>('[data-slot="dialog-popup"] .overflow-y-auto')!;
    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
    body.scrollTop = body.scrollHeight;
    expect(body.scrollTop).toBeGreaterThan(0);
    assertFrame();
  }
  await screen.getByRole("button", { name: "Set up", exact: true }).click();
  await expect.element(screen.getByRole("heading", { name: "Choose your agents" })).toBeVisible();
  assertFrame();
  await screen.unmount();
});
