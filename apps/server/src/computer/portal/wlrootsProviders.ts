/**
 * Constructing the wlroots provider set from a probe.
 *
 * Which provider a desktop *would* use is decided in `probe.ts` and is a pure
 * function of what the compositor advertises. This module is the other half:
 * turning those choices into live objects, and doing the one thing the plan
 * cannot — owning the helper process the three Wayland-native providers share.
 *
 * A single helper holds one `wl_display` for input, capture, and windows, so
 * the virtual devices, the screencopy buffers, and the toplevel list all belong
 * to one client. That is not an optimization: a second connection would get a
 * second set of virtual devices, and the compositor's idea of which keys are
 * held down would depend on which connection sent them.
 *
 * Nothing here decides availability. A slot that is not returned is left to the
 * plan's own sentence, which names the missing global or the missing package.
 */
import { createDesktopHelperIdleSource } from "../sharedSeatArbiter.ts";
import {
  DesktopHelperClient,
  shareDesktopHelper,
  type DesktopHelperTransport,
} from "./desktopHelperClient.ts";
import { ForeignToplevelWindowProvider } from "./foreignToplevelWindowProvider.ts";
import { usesProvider, type PortalProbe, type PortalProviderPlan } from "./probe.ts";
import {
  resolvedProvider,
  type PortalCaptureProvider,
  type PortalClipboardProvider,
  type PortalInputProvider,
  type PortalProviderId,
  type PortalProviders,
  type PortalWindowProvider,
} from "./providers.ts";
import { createWlClipboardProvider } from "./wlClipboardProvider.ts";
import { WlrScreencopyProvider } from "./wlrScreencopyProvider.ts";
import { WlrootsInputProvider } from "./wlrootsInputProvider.ts";

/** The slots one shared helper serves, and the implementation each one requires. */
const HELPER_BACKED: Readonly<Record<"input" | "capture" | "windows", PortalProviderId>> = {
  input: "wlroots-virtual-input",
  capture: "wlr-screencopy",
  windows: "wlr-foreign-toplevel",
};

export interface WlrootsProviderOptions {
  /**
   * Environment for the helper and for wl-clipboard. A nested session passes
   * its own `WAYLAND_DISPLAY` here, which is the whole of what makes these
   * providers address an isolated compositor instead of the human's.
   */
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam: swaps the supervised process for a fake transport. */
  readonly createHelper?: (options: {
    readonly command: string;
    readonly env?: NodeJS.ProcessEnv;
  }) => DesktopHelperTransport;
  readonly createClipboard?: (env?: NodeJS.ProcessEnv) => PortalClipboardProvider;
}

/**
 * The providers that could be built for this desktop, keyed by slot. An absent
 * key is a slot with no wlroots implementation here; the caller supplies the
 * refusal, so a gap never becomes a silently degraded capability.
 */
export type ResolvedWlrootsProviders = Partial<PortalProviders>;

export function resolveWlrootsProviders(
  probe: PortalProbe,
  plan: PortalProviderPlan,
  options: WlrootsProviderOptions = {},
): ResolvedWlrootsProviders {
  const resolved: {
    input?: PortalProviders["input"];
    capture?: PortalProviders["capture"];
    windows?: PortalProviders["windows"];
    clipboard?: PortalProviders["clipboard"];
    seatIdle?: NonNullable<PortalProviders["seatIdle"]>;
  } = {};

  const command = probe.helperBinary;
  // Counted before anything is constructed, so the share count is known up
  // front and a desktop that needs no helper never spawns one.
  const helperSlots =
    command === undefined
      ? []
      : (["input", "capture", "windows"] as const).filter((slot) =>
          usesProvider(plan, slot, HELPER_BACKED[slot]),
        );

  if (command !== undefined && helperSlots.length > 0) {
    const helper = (options.createHelper ?? defaultCreateHelper)({
      command,
      ...(options.env ? { env: options.env } : {}),
    });
    // One more user than there are capability slots: the idle source is the
    // extra. It never justifies a helper of its own — `helperSlots.length > 0`
    // is what got here — but where one exists anyway, `ext_idle_notify_v1`
    // rides the same connection rather than opening a second one.
    const releases = shareDesktopHelper(helper, helperSlots.length + 1);
    const idleRelease = releases[helperSlots.length] ?? (() => helper.dispose());
    // Built unconditionally rather than gated on the compositor advertising
    // `ext_idle_notifier_v1`: a compositor without it refuses the first sample
    // permanently, which stands the arbiter down with the helper's own sentence
    // in health — more useful than silently never yielding.
    resolved.seatIdle = { ...createDesktopHelperIdleSource(helper), dispose: idleRelease };
    helperSlots.forEach((slot, index) => {
      // The fallback is unreachable — `shareDesktopHelper` returns exactly one
      // release per user — and disposing directly is a safe reading of it in
      // any case, because disposal is idempotent.
      const release = releases[index] ?? (() => helper.dispose());
      switch (slot) {
        case "input":
          resolved.input = resolvedProvider<PortalInputProvider>(
            new WlrootsInputProvider(helper, release),
          );
          break;
        case "capture":
          resolved.capture = resolvedProvider<PortalCaptureProvider>(
            new WlrScreencopyProvider(helper, release),
          );
          break;
        case "windows":
          resolved.windows = resolvedProvider<PortalWindowProvider>(
            new ForeignToplevelWindowProvider(helper, release),
          );
          break;
      }
    });
  }

  // The clipboard runs separate short-lived processes and needs no helper, so
  // it resolves on desktops where every Wayland-native slot refused.
  if (usesProvider(plan, "clipboard", "wl-clipboard")) {
    resolved.clipboard = resolvedProvider<PortalClipboardProvider>(
      (options.createClipboard ?? createWlClipboardProvider)(options.env),
    );
  }

  return resolved;
}

function defaultCreateHelper(options: {
  readonly command: string;
  readonly env?: NodeJS.ProcessEnv;
}): DesktopHelperTransport {
  return new DesktopHelperClient(options);
}
