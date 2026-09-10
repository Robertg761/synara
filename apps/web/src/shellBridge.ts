// The single adapter for Synara's native secure-storage plugin.
import { registerPlugin } from "@capacitor/core";
import type { MobileBridge, MobileShellSession } from "@synara/contracts";

import { isMobileShell } from "./env";

interface SynaraShellPlugin {
  getSession: () => Promise<{ serverUrl?: unknown; sessionToken?: unknown }>;
  setSession: (session: MobileShellSession) => Promise<void>;
  clearSession: () => Promise<void>;
  consumeLaunchUrl: (options: { expectedUrl?: string }) => Promise<{ url?: unknown }>;
}

const plugin = registerPlugin<SynaraShellPlugin>("SynaraShell");

const bridge: MobileBridge = {
  consumeLaunchUrl: async (expectedUrl) => {
    const result = await plugin.consumeLaunchUrl(expectedUrl ? { expectedUrl } : {});
    return typeof result.url === "string" ? result.url : null;
  },
  session: {
    get: async () => {
      const stored = await plugin.getSession();
      if (stored.serverUrl === undefined && stored.sessionToken === undefined) return null;
      if (
        typeof stored.serverUrl !== "string" || !stored.serverUrl.trim() ||
        typeof stored.sessionToken !== "string" || !stored.sessionToken.trim()
      ) {
        throw new Error("The native shell returned an invalid saved connection.");
      }
      return { serverUrl: stored.serverUrl, sessionToken: stored.sessionToken };
    },
    set: (session) => plugin.setSession(session),
    clear: () => plugin.clearSession(),
  },
};

export function getMobileBridge(): MobileBridge | null {
  return isMobileShell ? bridge : null;
}
// Consumed natively so even a renderer reload cannot replay an old pairing link.
export async function consumeMobileLaunchUrl(expectedUrl?: string): Promise<string | null> {
  if (!isMobileShell) return null;
  return bridge.consumeLaunchUrl(expectedUrl);
}
