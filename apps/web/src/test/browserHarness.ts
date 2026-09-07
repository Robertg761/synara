import type { ServerConfig } from "@synara/contracts";
import { page } from "vitest/browser";

export function createBrowserTestServerConfig(checkedAt: string): ServerConfig {
  return {
    cwd: "/repo/project",
    worktreesDir: "/repo/.codex/worktrees",
    keybindingsConfigPath: "/repo/project/.synara-keybindings.json",
    keybindings: [],
    issues: [],
    providers: [
      {
        provider: "codex",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        supportsAutoRuntimeMode: true,
        checkedAt,
      },
    ],
    availableEditors: [],
  };
}

export function createFullscreenTestHost(): HTMLDivElement {
  const host = document.createElement("div");
  Object.assign(host.style, {
    position: "fixed",
    inset: "0",
    width: "100vw",
    height: "100vh",
    display: "grid",
    overflow: "hidden",
  });
  document.body.append(host);
  return host;
}

/** iPhone 14/15-class portrait viewport — the reference geometry for phone-layout tests. */
export const PHONE_VIEWPORT = { width: 390, height: 844 } as const;

/**
 * Resizes the test browser to a phone-sized portrait viewport and returns a fresh fullscreen
 * host. Phone layout keys off the real viewport (`useLayoutMode`, matchMedia at 768px), so tests
 * must resize the window itself — merely constraining a container's width would leave every
 * media query in desktop mode.
 */
export async function renderAtPhoneViewport(): Promise<HTMLDivElement> {
  await page.viewport(PHONE_VIEWPORT.width, PHONE_VIEWPORT.height);
  return createFullscreenTestHost();
}
