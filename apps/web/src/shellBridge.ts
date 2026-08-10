// FILE: shellBridge.ts
// Purpose: The ONLY file in apps/web that knows Capacitor's runtime shape. Adapts the injected
// `window.Capacitor.Plugins.SynaraShell` global to the MobileBridge contract so the rest of the
// app depends on the contract and never on Capacitor.
// Layer: Web shell integration
// Depends on: ~/env (isMobileShell), @synara/contracts (MobileBridge)
// Exports: getMobileBridge

import type {
  MobileBridge,
  MobileShellEventMap,
  MobileShellEventName,
  MobileShellListenerHandle,
  MobileShellSession,
} from "@synara/contracts";

import { isMobileShell } from "~/env";

/**
 * Raw plugin surface as Capacitor exposes it: every method takes/returns a plain object and
 * values cross a bridge that can hand us anything. Kept structurally loose on purpose — the
 * adapter below is where it is narrowed to the contract.
 */
interface SynaraShellPlugin {
  getSession?: () => Promise<{ serverUrl?: unknown; sessionToken?: unknown } | null>;
  setSession?: (options: MobileShellSession) => Promise<void>;
  clearSession?: () => Promise<void>;
  consumePendingThreadOpen?: () => Promise<{ threadId?: unknown } | null>;
  addListener?: (
    eventName: string,
    listener: (event: unknown) => void,
  ) => Promise<MobileShellListenerHandle>;
}

interface CapacitorGlobal {
  readonly Plugins?: { readonly SynaraShell?: SynaraShellPlugin };
}

function readPlugin(): SynaraShellPlugin | null {
  if (!isMobileShell) return null;
  try {
    return (window as { Capacitor?: CapacitorGlobal }).Capacitor?.Plugins?.SynaraShell ?? null;
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toSession(
  raw: { serverUrl?: unknown; sessionToken?: unknown } | null,
): MobileShellSession | null {
  const serverUrl = nonEmptyString(raw?.serverUrl);
  const sessionToken = nonEmptyString(raw?.sessionToken);
  return serverUrl && sessionToken ? { serverUrl, sessionToken } : null;
}

const NOOP_LISTENER_HANDLE: MobileShellListenerHandle = {
  remove: () => Promise.resolve(),
};

function adapt(plugin: SynaraShellPlugin): MobileBridge {
  return {
    session: {
      get: async () => toSession((await plugin.getSession?.()) ?? null),
      set: async (session) => {
        await plugin.setSession?.(session);
      },
      clear: async () => {
        await plugin.clearSession?.();
      },
    },
    consumePendingThreadOpen: async () =>
      nonEmptyString((await plugin.consumePendingThreadOpen?.())?.threadId),
    addListener: async <E extends MobileShellEventName>(
      eventName: E,
      listener: (event: MobileShellEventMap[E]) => void,
    ) => {
      if (!plugin.addListener) return NOOP_LISTENER_HANDLE;
      return plugin.addListener(eventName, (event) => {
        listener((event ?? {}) as MobileShellEventMap[E]);
      });
    },
  };
}

/**
 * The mobile shell bridge, or null in every other runtime (browser tab, Electron) and when the
 * shell is running a build that does not expose the plugin yet. Callers must treat null as
 * "no mobile shell" rather than as an error.
 */
export function getMobileBridge(): MobileBridge | null {
  const plugin = readPlugin();
  return plugin ? adapt(plugin) : null;
}
