/**
 * Constructing the providers that share one granted portal session.
 *
 * The counterpart to `wlrootsProviders.ts`, and the same shape: the plan decides
 * *which* provider a desktop would use, this module turns the usable choices
 * into live objects and owns the one resource they share. There the resource is
 * a helper process holding a `wl_display`; here it is a portal session holding a
 * consent grant.
 *
 * Sharing is not an optimization. Every session costs the user a dialog, so two
 * sessions for input and clipboard would mean two dialogs for one feature, and
 * the clipboard interface is only reachable *inside* a remote-control session
 * anyway. One session, opened lazily on the first action that needs it, is the
 * only shape that is both honest to the user and correct.
 *
 * Selection is driven by the plan rather than by the desktop name, so a non-
 * GNOME desktop whose portal happens to be the best available option gets the
 * same providers without a special case. In practice today that set is GNOME.
 */
// The refcounted release in `desktopHelperClient.ts` is not helper-specific —
// it counts users of anything disposable — so it is reused rather than restated
// here. Aliased because the call site is a portal session, not a helper.
import { createMutterIdleSource, type SeatIdleSource } from "../sharedSeatArbiter.ts";
import { shareDesktopHelper as shareDisposable } from "./desktopHelperClient.ts";
import {
  PortalSession,
  type PortalSessionConsent,
  type PortalSessionOptions,
} from "./portalSession.ts";
import { PortalRemoteDesktopInputProvider } from "./portalRemoteDesktopInputProvider.ts";
import {
  PortalSelectionClipboardProvider,
  type PortalSelectionClipboardProviderOptions,
} from "./portalSelectionClipboardProvider.ts";
import { usesProvider, type PortalProbe, type PortalProviderPlan } from "./probe.ts";
import {
  resolvedProvider,
  type PortalClipboardProvider,
  type PortalInputProvider,
  type PortalProviderId,
  type PortalProviders,
} from "./providers.ts";
import type { PortalRestoreTokenStore } from "./restoreTokenStore.ts";

/** The slots one granted session serves, and the implementation each requires. */
const SESSION_BACKED: Readonly<Record<"input" | "clipboard", PortalProviderId>> = {
  input: "portal-remote-desktop",
  clipboard: "portal-selection",
};

export interface PortalSessionProviderOptions {
  /** Test seam: swaps the real D-Bus session for the fake portal service. */
  readonly createSession?: (options: PortalSessionOptions) => PortalSession;
  readonly restoreTokens?: PortalRestoreTokenStore;
  /**
   * Where consent transitions go. The backend owns the consent state machine —
   * including the denial latch — so the session only reports, and the wiring
   * that connects the two lives in `createPortalComputerBackend`.
   */
  readonly onConsentChanged?: (state: PortalSessionConsent, reason?: string) => void;
  /** Fires when the desktop revokes a grant: screen lock, or Stop in the indicator. */
  readonly onSessionClosed?: (reason: string) => void;
  readonly startTimeoutMs?: number;
  readonly clipboardOptions?: PortalSelectionClipboardProviderOptions;
  /** Test seam: swaps `org.gnome.Mutter.IdleMonitor` for a scripted clock. */
  readonly createSeatIdleSource?: () => SeatIdleSource;
}

export type ResolvedPortalSessionProviders = Partial<PortalProviders>;

export function resolvePortalSessionProviders(
  probe: PortalProbe,
  plan: PortalProviderPlan,
  options: PortalSessionProviderOptions = {},
): ResolvedPortalSessionProviders {
  const slots = (["input", "clipboard"] as const).filter((slot) =>
    usesProvider(plan, slot, SESSION_BACKED[slot]),
  );
  if (slots.length === 0) return {};

  // The idle clock is `org.gnome.Mutter.IdleMonitor`, which is gnome-shell's
  // and nothing else's. It is resolved from the plan like everything else here
  // rather than from `probe.desktop`: on a portal desktop that is not GNOME
  // nothing owns that name, the first sample says so permanently, and the
  // arbiter stands down with that sentence — which is the honest answer, and a
  // more useful one than a desktop-name check silently producing none.
  // Connecting is lazy inside the source, so this costs no bus traffic here.
  const seatIdle: SeatIdleSource & { close?(): void } = (
    options.createSeatIdleSource ?? createMutterIdleSource
  )();

  const session = (
    options.createSession ?? ((sessionOptions) => new PortalSession(sessionOptions))
  )({
    ...(probe.portal.availableDeviceTypes === undefined
      ? {}
      : { availableDeviceTypes: probe.portal.availableDeviceTypes }),
    ...(probe.portal.remoteDesktopVersion === undefined
      ? {}
      : { remoteDesktopVersion: probe.portal.remoteDesktopVersion }),
    // A ScreenCast session is joined whenever the portal has one, because it is
    // what gives absolute pointer motion a coordinate space — not because
    // anything here is going to read its pixels.
    withScreenCast: probe.portal.screenCastVersion !== undefined,
    withClipboard: slots.includes("clipboard"),
    desktop: probe.desktop,
    ...(options.restoreTokens ? { restoreTokens: options.restoreTokens } : {}),
    ...(options.onConsentChanged ? { onConsentChanged: options.onConsentChanged } : {}),
    ...(options.startTimeoutMs === undefined ? {} : { startTimeoutMs: options.startTimeoutMs }),
  });
  if (options.onSessionClosed) session.onClosed(options.onSessionClosed);

  const releases = shareDisposable(session, slots.length);
  let input: ResolvedPortalSessionProviders["input"];
  let clipboard: ResolvedPortalSessionProviders["clipboard"];
  for (const [index, slot] of slots.entries()) {
    // Unreachable fallback — one release is returned per user — but disposing
    // directly reads the same way, and disposal is idempotent.
    const release = releases[index] ?? (() => session.dispose());
    if (slot === "input") {
      input = resolvedProvider<PortalInputProvider>(
        new PortalRemoteDesktopInputProvider(session, release),
      );
    } else {
      clipboard = resolvedProvider<PortalClipboardProvider>(
        new PortalSelectionClipboardProvider(session, release, options.clipboardOptions ?? {}),
      );
    }
  }
  return {
    ...(input ? { input } : {}),
    ...(clipboard ? { clipboard } : {}),
    // Holds no share of the portal session: its bus connection is its own, so
    // it is closed on its own rather than through the session's refcount.
    seatIdle: {
      sample: (windowMs) => seatIdle.sample(windowMs),
      dispose: () => {
        seatIdle.close?.();
        return Promise.resolve();
      },
    },
  };
}
