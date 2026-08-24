/**
 * The four capabilities a Tier 2 desktop can supply, as interfaces.
 *
 * `PortalComputerBackend` is one class for every non-KDE Wayland desktop
 * because the bulk of a backend — supervision, health accounting, capture
 * serialization, glide timing, stroke sequencing, region/scale math — is
 * identical whatever the display server is. What actually differs is only how
 * four things are obtained: input, capture, windows, and clipboard. GNOME gets
 * them from portals plus a shell extension, wlroots from unprivileged Wayland
 * protocols, and a future X11 set from XTEST and EWMH; all three drop into
 * these interfaces without the backend knowing which is behind them.
 *
 * A provider is either resolved or missing *with a reason*. There is no third
 * "resolved but empty" state, because that is the shape that made an agent
 * relaunch the same app three times: a `listWindows()` that answers `[]` on a
 * desktop with no enumeration is indistinguishable from an empty desktop.
 */
import type { ComputerPoint, ComputerRect, ComputerWindow } from "@synara/contracts";

import { ComputerBackendError } from "../ComputerBackend.ts";
import type { ComputerInputSink } from "../pointerSequencing.ts";
import type { SeatIdleSource } from "../sharedSeatArbiter.ts";

/**
 * Every provider implementation the Tier 2 architecture has a place for, named
 * so a probe result and a refusal message can say which one a desktop would
 * use. Selection picks one of these per capability; whether it can be built yet
 * is a separate question, which is what keeps the decision table testable ahead
 * of the implementations.
 */
export const PORTAL_PROVIDER_IDS = [
  "portal-remote-desktop",
  "libei",
  "pipewire-screencast",
  "wlroots-virtual-input",
  "wlr-screencopy",
  "wlr-foreign-toplevel",
  "gnome-shell-extension",
  "hyprland-ipc",
  "portal-selection",
  "wl-clipboard",
] as const;
export type PortalProviderId = (typeof PORTAL_PROVIDER_IDS)[number];

/** The four capability slots, in the order a probe reports them. */
export const PORTAL_CAPABILITY_SLOTS = ["input", "capture", "windows", "clipboard"] as const;
export type PortalCapabilitySlot = (typeof PORTAL_CAPABILITY_SLOTS)[number];

/**
 * Input. `sink` is the same `ComputerInputSink` the KWin backend drives, so the
 * eased glide, the shift bookkeeping, and the hotkey release order in
 * `pointerSequencing.ts` are shared verbatim rather than restated per desktop.
 */
export interface PortalInputProvider {
  readonly id: PortalProviderId;
  /**
   * The agent shares the human's seat. True for every Tier 2 provider — neither
   * libei nor wlroots' virtual devices create a second pointer — but carried on
   * the provider rather than assumed, because it is what the panel's
   * shared-control warning keys off and an X11 or nested provider differs.
   */
  readonly sharedSeat: boolean;
  readonly sink: ComputerInputSink;
  /**
   * Clears a denied consent latch on the session behind this provider, when
   * there is one, so the next action may ask again. Only the human-driven
   * recovery path calls it; providers whose transport needs no consent omit it.
   */
  resetDeniedConsent?(): void;
  /** Discrete scroll, which is an axis event rather than a button or key. */
  scroll(deltaX: number, deltaY: number): Promise<void>;
  /** Where the pointer is, when the transport reports it. Absent means unknown. */
  pointerPosition?(): Promise<ComputerPoint | undefined>;
  dispose(): Promise<void>;
}

export interface PortalCapturedImage {
  /** PNG bytes. The region/scale mapping is derived from the image's own header. */
  readonly bytes: Uint8Array;
  /** Desktop rect the pixels cover, in the same space as pointer coordinates. */
  readonly region: ComputerRect;
}

export interface PortalCaptureProvider {
  readonly id: PortalProviderId;
  /** See `PortalInputProvider.resetDeniedConsent`. */
  resetDeniedConsent?(): void;
  /** The union of every output, which is the coordinate space windows live in. */
  workspaceRect(): Promise<ComputerRect>;
  captureRegion(region: ComputerRect, maxDimension: number): Promise<PortalCapturedImage>;
  dispose(): Promise<void>;
}

export interface PortalWindowProvider {
  readonly id: PortalProviderId;
  /**
   * Whether enumerated windows carry a rect. False under wlroots'
   * foreign-toplevel protocol, which reports a title, an app id, and activation
   * and nothing about position — the case `ComputerWindow.bounds` was made
   * optional for.
   */
  readonly providesBounds: boolean;
  /** Whether `stackingIndex`/`occludedBy` are real, so occlusion is knowable. */
  readonly providesStacking: boolean;
  listWindows(): Promise<readonly ComputerWindow[]>;
  /** Present only when the desktop can be told to focus a window. */
  activateWindow?(windowId: string): Promise<void>;
  /** Present only when a window can be restacked without moving focus. */
  raiseWindow?(windowId: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface PortalClipboardProvider {
  readonly id: PortalProviderId;
  /** See `PortalInputProvider.resetDeniedConsent`. */
  resetDeniedConsent?(): void;
  read(): Promise<string>;
  write(text: string): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * A resolved provider, or the precise reason there is none.
 *
 * The reason is a full sentence naming the missing piece and what to do about
 * it — a package to install, a script to run, a phase that has not landed —
 * because it is what reaches a tool call and an availability card verbatim.
 */
export type ProviderSlot<T> =
  | { readonly available: true; readonly provider: T }
  | { readonly available: false; readonly reason: string };

export function resolvedProvider<T>(provider: T): ProviderSlot<T> {
  return { available: true, provider };
}

export function missingProvider<T>(reason: string): ProviderSlot<T> {
  return { available: false, reason };
}

/**
 * The seat's idle clock, on a desktop that can report one.
 *
 * `dispose` is part of it because on wlroots the source rides the same helper
 * process the three Wayland-native providers share, and so holds a refcount on
 * it exactly as they do.
 */
export interface PortalSeatIdleSource extends SeatIdleSource {
  dispose(): Promise<void>;
}

export interface PortalProviders {
  readonly input: ProviderSlot<PortalInputProvider>;
  readonly capture: ProviderSlot<PortalCaptureProvider>;
  readonly windows: ProviderSlot<PortalWindowProvider>;
  readonly clipboard: ProviderSlot<PortalClipboardProvider>;
  /**
   * Not a `ProviderSlot`, because its absence is not a refused capability. No
   * tool asks for the human's idle time; it exists so the agent can give way,
   * and a desktop that cannot report it is one where the arbiter stands down
   * and says so in health — never one where an action is refused.
   */
  readonly seatIdle?: PortalSeatIdleSource;
}

/**
 * The provider behind a capability, or a refusal that names what is missing.
 *
 * Non-retryable on purpose: a provider that did not resolve at construction
 * will not resolve on the next call either, and a retryable error would put the
 * agent in a loop against a desktop that is never going to answer. This is the
 * single place the "degrade honestly, never silently" rule is enforced, so
 * every capability-gated path refuses in the same words.
 */
export function requireProvider<T>(slot: ProviderSlot<T>, attempted: string): T {
  if (slot.available) return slot.provider;
  throw new ComputerBackendError(`${attempted} is not available on this desktop. ${slot.reason}`, {
    retryable: false,
  });
}
