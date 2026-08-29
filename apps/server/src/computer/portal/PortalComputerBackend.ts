/**
 * Tier 2: one backend for every non-KDE Wayland desktop.
 *
 * Tier 1 proved that the bulk of a computer backend is not display-server
 * specific — supervision, health accounting, capture serialization, glide
 * timing, stroke sequencing, region/scale math — so this class owns all of it
 * once and delegates only four things to providers the probe resolved at
 * construction: input, capture, windows, clipboard. GNOME supplies them through
 * portals plus a Shell extension, wlroots through unprivileged protocols; this
 * class does not know which.
 *
 * Two rules run through the whole file.
 *
 * **Degrade honestly, never silently.** Every capability-gated path goes
 * through `requireProvider`, which refuses with a non-retryable error naming
 * the missing piece and what to do about it. Nothing here returns an empty
 * window list, a blank screenshot, or a silent success — an agent cannot tell
 * those from the real thing, and the E2E runs showed exactly what it does when
 * it cannot: it relaunches the same app until the turn ends.
 *
 * **A missing grant is not unavailable.** The desktop's own consent dialog is
 * a user action, not a fault. Availability stays `available` while consent is
 * outstanding and health reports `awaiting-consent`, because an `unavailable`
 * badge hides the one thing the user has to do. A denial latches: it is never
 * retried automatically, exactly like the Tier 1 release-hotkey latch.
 */
import { spawn, type ChildProcess } from "node:child_process";

import type {
  ComputerAvailability,
  ComputerCapabilities,
  ComputerHealth,
  ComputerId,
  ComputerLaunchAppResult,
  ComputerPoint,
  ComputerRect,
  ComputerScreenSize,
  ComputerScreenshot,
  ComputerSeatHealth,
  ComputerState,
  ComputerWindow,
} from "@synara/contracts";
import { describeErrorMessage } from "@synara/shared/errorMessages";

import {
  clampComputerMessage,
  ComputerBackendError,
  intersectComputerRects,
  DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION,
  MAX_COMPUTER_CLIPBOARD_BYTES,
  type ComputerBackend,
  type ComputerBackendActionResult,
  type ComputerBackendEvent,
  type ComputerBackendEventListener,
  type ComputerCaptureRequest,
  type ComputerFrameListener,
  type ComputerResolvedTarget,
} from "../ComputerBackend.ts";
import { resolveAppLaunchOnHost, type AppLaunchResolver } from "../appLaunchResolution.ts";
import type { DesktopHelperProvisionResult } from "../provisioning/desktopHelperProvisioning.ts";
import {
  alignRect,
  formatRect,
  requireWindowBounds,
  screenshotFromPng,
  shiftPoint,
  shiftRect,
  windowInAgentSpace,
} from "../computerGeometry.ts";
import { ComputerHealthState } from "../computerHealthState.ts";
import { EVDEV_BUTTON_CODES, keyStrokeForKey, qwertyTextKeyStrokes } from "../evdevInput.ts";
import {
  glidePointerToDeadline,
  POINTER_SEQUENCE_OPERATIONS,
  pressButtonOnce,
  pressHotkeyStrokes,
  pressKeyStroke,
} from "../pointerSequencing.ts";
import { SharedSeatArbiter } from "../sharedSeatArbiter.ts";
import { clampUtf8Bytes } from "../utf8Truncation.ts";
import {
  connectGnomeShellExtension,
  GnomeShellWindowProvider,
  type GnomeShellExtensionConnect,
} from "./gnomeShellWindowProvider.ts";
import {
  resolvePortalSessionProviders,
  type PortalSessionProviderOptions,
} from "./portalSessionProviders.ts";
import { resolveDesktopHelper, type DesktopHelperResolution } from "./desktopHelperInstall.ts";
import {
  planPortalProviders,
  probeDesktop,
  usesProvider,
  type PortalProbe,
  type PortalProviderChoice,
  type PortalProviderPlan,
} from "./probe.ts";
import {
  missingProvider,
  requireProvider,
  resolvedProvider,
  type PortalProviders,
  type PortalWindowProvider,
  type ProviderSlot,
} from "./providers.ts";
import { resolveWlrootsProviders, type WlrootsProviderOptions } from "./wlrootsProviders.ts";

const DEFAULT_COMPUTER_ID = "primary" as ComputerId;
const DEFAULT_GLIDE_DURATION_MS = 180;
const DEFAULT_STILL_INTERVAL_MS = 500;
/** Names this backend in a capture failure, which reaches a tool call verbatim. */
const CAPTURE_SOURCE = "Synara portal capture";
/** Stands in when an availability refusal arrives empty, which the contract forbids. */
const UNAVAILABLE_FALLBACK_MESSAGE =
  "The Synara portal backend is unavailable, and the failure carried no message.";

/**
 * Where the desktop's permission dialog stands.
 *
 * `denied` is terminal until a user action clears it. Retrying a denied grant
 * re-raises the dialog the user just dismissed, which is indistinguishable from
 * an application that will not take no for an answer.
 */
export type PortalConsentState =
  | "not-required"
  | "not-requested"
  | "awaiting"
  | "granted"
  | "denied";

export interface PortalComputerBackendOptions {
  readonly computerId?: string;
  readonly probe: PortalProbe;
  readonly providers: PortalProviders;
  readonly platform?: string;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly spawnProcess?: (app: string, args: readonly string[]) => ChildProcess;
  /** Name-to-executable resolution, replaced in tests to avoid host lookups. */
  readonly resolveApp?: AppLaunchResolver;
  readonly glideDurationMs?: number;
  readonly stillIntervalMs?: number;
  readonly captureMaxDimension?: number;
  /**
   * Re-runs the desktop probe, so capabilities the first probe planned away —
   * a helper that was not built yet, wl-clipboard installed since — can come
   * back without a server restart. Production wires `probeDesktop`; tests omit
   * it and nothing is ever re-probed.
   */
  readonly recomputeProbe?: () => Promise<PortalProbe>;
  /** Rebuilds the provider set from a fresh probe; see `recomputeProbe`. */
  readonly buildProviders?: (probe: PortalProbe) => PortalProviders;
  /**
   * Installs the shipped desktop helper when the probe found none. Run only on
   * the establishing path — never from the passive probe, which must install
   * nothing. Production wires `resolveDesktopHelper`; tests omit it and no
   * install is ever attempted.
   */
  readonly resolveHelper?: () => Promise<DesktopHelperResolution>;
  /**
   * Whether this desktop needs a consent dialog at all. wlroots grants nothing
   * and prompts for nothing, so its consent state starts and stays
   * `not-required`; GNOME's portal starts at `not-requested`.
   */
  readonly consent?: PortalConsentState;
  /**
   * Installs or compiles the desktop helper, for the establishing read and the
   * settings panel's setup action. Heavier than `resolveHelper`, which only
   * copies a shipped binary: this one may run a compiler. Absent in tests and
   * in nested sessions, where the helper is supplied by whatever started the
   * compositor. A successful run is followed by an unthrottled `recomputeProbe`
   * so the new binary's capabilities appear at once.
   */
  readonly provisionHelper?: () => Promise<DesktopHelperProvisionResult>;
  /** Whether provisioning could plausibly succeed, asked without doing it. */
  readonly couldProvisionHelper?: () => Promise<boolean>;
}

export class PortalComputerBackend implements ComputerBackend {
  readonly computerId: ComputerId;

  /**
   * Replaced when a reprobe finds the desktop changed — a helper provisioned,
   * wl-clipboard installed. The plan, providers, capability set, and arbiter
   * follow it in `reprobeOnce`, because a half-updated set would report
   * capabilities the providers cannot serve.
   */
  private probe: PortalProbe;
  private plan: PortalProviderPlan;
  private providers: PortalProviders;
  private readonly platform: string;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly spawnProcess: (app: string, args: readonly string[]) => ChildProcess;
  private readonly resolveApp: AppLaunchResolver;
  private readonly glideDurationMs: number;
  private readonly stillIntervalMs: number;
  private readonly captureMaxDimension: number;
  private readonly recomputeProbe: (() => Promise<PortalProbe>) | undefined;
  private readonly buildProviders: ((probe: PortalProbe) => PortalProviders) | undefined;
  /**
   * The desktop probe is a snapshot, and the desktop moves: wl-clipboard gets
   * installed, the helper binary appears. This is how the snapshot catches up —
   * at most once per interval, and only while some capability is missing.
   */
  private static readonly REPROBE_MIN_INTERVAL_MS = 30_000;
  private lastReprobeAt = Number.NEGATIVE_INFINITY;
  private reprobing: Promise<void> | undefined;
  private readonly resolveHelper: (() => Promise<DesktopHelperResolution>) | undefined;
  private lastHelperResolveAt = Number.NEGATIVE_INFINITY;
  private helperResolving: Promise<void> | undefined;
  private readonly healthState: ComputerHealthState;
  /** Rebuilt when a reprobe upgrades a provider slot; see `reprobeOnce`. */
  private capabilitySet: ComputerCapabilities;
  private readonly eventListeners = new Set<ComputerBackendEventListener>();
  /**
   * The traffic rule between the agent and the human, on the desktops where
   * there is one seat between them. See `sharedSeatArbiter.ts`; absent here
   * means there is nobody to yield to, and every mutating action runs straight
   * through.
   */
  private arbiter: SharedSeatArbiter | undefined;

  private consent: PortalConsentState;
  private consentReason: string | undefined;
  private seatPrimed = false;
  private disposed = false;
  private currentPoint: ComputerPoint | null = null;
  /**
   * The global-space origin agent coordinates are translated by. The providers
   * all speak the desktop's layout space, whose top-left sits at negative
   * globals when a monitor is left of or above the primary; everything crossing
   * this backend's boundary speaks agent space — 0..screenSize — instead, the
   * same contract `KWinComputerBackend` keeps. Refreshed on every workspace
   * read; (0, 0) until one happens, which is exact on single-monitor layouts.
   */
  private lastAgentOrigin: ComputerPoint = { x: 0, y: 0 };
  private streamListener: ComputerFrameListener | undefined;
  private streamTimer: ReturnType<typeof setInterval> | undefined;
  private stillInFlight = false;
  private nextSequence = 1;
  private readonly provisionHelper: (() => Promise<DesktopHelperProvisionResult>) | undefined;
  private readonly couldProvisionHelper: (() => Promise<boolean>) | undefined;
  /** Memoized so concurrent tool calls share one install rather than racing. */
  private provisionPromise: Promise<string | undefined> | undefined;
  /**
   * The install itself, shared between `availability()` and the settings
   * panel's `provision()`. Two concurrent installs would collide in the
   * staging directory, so whoever asks while one is in flight joins it.
   */
  private provisionInFlight: Promise<DesktopHelperProvisionResult> | undefined;

  constructor(options: PortalComputerBackendOptions) {
    this.computerId = (options.computerId ?? DEFAULT_COMPUTER_ID) as ComputerId;
    this.probe = options.probe;
    this.plan = planPortalProviders(options.probe);
    this.providers = options.providers;
    this.recomputeProbe = options.recomputeProbe;
    this.buildProviders = options.buildProviders;
    this.resolveHelper = options.resolveHelper;
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => delay(milliseconds));
    this.spawnProcess =
      options.spawnProcess ??
      ((app, args) => spawn(app, [...args], { detached: true, stdio: "ignore" }));
    this.resolveApp = options.resolveApp ?? resolveAppLaunchOnHost;
    this.glideDurationMs = Math.max(0, options.glideDurationMs ?? DEFAULT_GLIDE_DURATION_MS);
    this.stillIntervalMs = Math.max(100, options.stillIntervalMs ?? DEFAULT_STILL_INTERVAL_MS);
    this.captureMaxDimension = normalizeDimension(options.captureMaxDimension);
    this.consent =
      options.consent ?? (options.probe.portal.present ? "not-requested" : "not-required");
    this.capabilitySet = capabilitiesFromProviders(options.providers);
    this.provisionHelper = options.provisionHelper;
    this.couldProvisionHelper = options.couldProvisionHelper;
    this.healthState = new ComputerHealthState({
      readStatus: () => {
        const seat = this.seatHealth();
        return {
          status: this.healthStatus(),
          captureAvailable: this.providers.capture.available,
          ...(seat ? { seat } : {}),
        };
      },
      emit: (health) => this.emit({ type: "health-changed", health }),
      now: () => this.now(),
      failureFallbackMessage: "The Synara portal backend failed without a message.",
    });
    // Two conditions, and both are the seat's rather than the desktop's. The
    // input provider says whether the agent drives the human's own seat — a
    // nested compositor or a dedicated seat has nobody to give way to, and an
    // arbiter there would refuse actions on behalf of a human who is not in the
    // room. The idle source says whether that seat can be watched at all.
    this.arbiter =
      options.providers.seatIdle !== undefined && this.capabilitySet.sharedSeat
        ? new SharedSeatArbiter({ source: options.providers.seatIdle, now: () => this.now() })
        : undefined;
    // Deliberately not primed here. The backend is built when the server boots,
    // and on a wlroots desktop the arbiter's first sample is what spawns the
    // helper — a compositor-attached process the server must not own on behalf
    // of a feature nobody has used yet. See `primeSeatArbiterOnce`.
  }

  /**
   * What resolved, not what the desktop might manage. A capability derived from
   * the probe rather than from a live provider would promise a tool that then
   * refuses, and the panel badge and tool descriptions read this to decide what
   * to offer.
   */
  capabilities(): ComputerCapabilities {
    return this.capabilitySet;
  }

  /**
   * The provider each capability would use on this desktop, and why any of them
   * is blocked. Read by the availability copy and exposed for diagnostics; the
   * decision itself is a pure function of the probe.
   */
  providerPlan(): PortalProviderPlan {
    return this.plan;
  }

  /**
   * The passive answer: it reads the desktop probe and the provider plan
   * derived from it, and starts no session, opens no dialog, spawns no helper,
   * and installs nothing. It shares the verdict with `availability()` rather
   * than being a second implementation that could drift from it; what the
   * establishing read adds is the licensed side effects — installing a shipped
   * helper the boot probe refused to, or compiling one.
   *
   * The one judgement call is the same trade `KWinComputerBackend` documents.
   * A desktop whose only blocker is a helper that does not exist *yet* answers
   * "available" when `couldProvisionHelper` says one can be produced. A wrong
   * yes costs the first real use one error card — the same card provisioning
   * already produces — while a wrong no costs the user the feature outright,
   * and, worse, is self-fulfilling: `supported` gates whether the computer
   * tools are offered at all, so a "no" here means nothing ever calls the
   * establishing read that would have fixed the machine.
   */
  probeAvailability(): Promise<ComputerAvailability> {
    return this.currentAvailability({ passive: true });
  }

  /**
   * Installs the shipped desktop helper on the establishing path, when the
   * probe found none. The boot probe must not install by contract, so without
   * this the prebuilts packaged with the app would never reach disk and the
   * helper-backed capabilities they carry would stay planned away until
   * someone ran build.sh by hand. Throttled like the reprobe; a successful
   * install un-throttles the next refresh so the new binary is seen at once.
   */
  private async resolveHelperIfMissing(): Promise<void> {
    if (this.disposed || this.resolveHelper === undefined) return;
    if (this.probe.helperBinary !== undefined) return;
    if (this.helperResolving) {
      await this.helperResolving;
      return;
    }
    if (this.now() - this.lastHelperResolveAt < PortalComputerBackend.REPROBE_MIN_INTERVAL_MS) {
      return;
    }
    this.lastHelperResolveAt = this.now();
    this.helperResolving = this.resolveHelper()
      .then((resolution) => {
        if (resolution.path !== undefined) this.lastReprobeAt = Number.NEGATIVE_INFINITY;
      })
      .catch(() => undefined)
      .finally(() => {
        this.helperResolving = undefined;
      });
    await this.helperResolving;
  }

  /**
   * Catches the snapshot up with the desktop, at most once per interval and
   * only while a capability is missing — so a panel refresh is what lets an
   * installed wl-clipboard or a newly built helper appear without a server
   * restart, and nothing re-probes on a desktop where everything resolved.
   */
  private async refreshCapabilitiesIfStale(): Promise<void> {
    const allResolved =
      this.providers.input.available &&
      this.providers.capture.available &&
      this.providers.windows.available &&
      this.providers.clipboard.available;
    if (
      this.disposed ||
      this.recomputeProbe === undefined ||
      allResolved ||
      this.now() - this.lastReprobeAt < PortalComputerBackend.REPROBE_MIN_INTERVAL_MS
    ) {
      return;
    }
    this.reprobing ??= this.reprobeOnce().finally(() => {
      this.reprobing = undefined;
    });
    await this.reprobing.catch(() => undefined);
  }

  /**
   * The unthrottled reprobe, for the moment right after provisioning changed
   * the desktop: the throttle exists to keep panel renders from hammering the
   * probe, not to hide a helper that was just installed. A reprobe already in
   * flight may have sampled the desktop before the install landed, so it is
   * waited out rather than joined, and a fresh one follows it.
   */
  private async reprobeNow(): Promise<void> {
    if (this.reprobing) await this.reprobing.catch(() => undefined);
    this.reprobing ??= this.reprobeOnce().finally(() => {
      this.reprobing = undefined;
    });
    await this.reprobing.catch(() => undefined);
  }

  private async reprobeOnce(): Promise<void> {
    this.lastReprobeAt = this.now();
    if (this.recomputeProbe === undefined) return;
    const fresh = await this.recomputeProbe().catch(() => undefined);
    // Disposal may have happened while the probe was in flight, and a provider
    // set adopted now would never be disposed.
    if (fresh === undefined || this.disposed) return;
    const freshPlan = planPortalProviders(fresh);
    // Only an upgrade swaps anything in: providers hold live sessions and
    // consent state, and rebuilding them would throw that away for nothing.
    const upgrades = (slot: "input" | "capture" | "windows" | "clipboard"): boolean =>
      freshPlan[slot].blockedBy === undefined && this.plan[slot].blockedBy !== undefined;
    if (
      !upgrades("input") &&
      !upgrades("capture") &&
      !upgrades("windows") &&
      !upgrades("clipboard")
    ) {
      return;
    }
    if (this.buildProviders === undefined) return;
    // Merge per slot rather than replacing the whole set: a slot that already
    // resolved keeps its provider — and with it any live session and consent —
    // while a slot that upgraded takes the freshly built one. The fresh build's
    // duplicates of kept slots are disposed rather than dropped, because a
    // constructed provider can hold a share of the helper process or the portal
    // session from birth.
    const built = this.buildProviders(fresh);
    const keepSlot = <T extends { dispose(): Promise<void> }>(
      current: ProviderSlot<T>,
      freshSlot: ProviderSlot<T>,
      currentChoice: PortalProviderChoice,
      freshChoice: PortalProviderChoice,
    ): { readonly slot: ProviderSlot<T>; readonly choice: PortalProviderChoice } => {
      if (!current.available) return { slot: freshSlot, choice: freshChoice };
      if (freshSlot.available && freshSlot.provider !== current.provider) {
        void freshSlot.provider.dispose();
      }
      return { slot: current, choice: currentChoice };
    };
    const input = keepSlot(this.providers.input, built.input, this.plan.input, freshPlan.input);
    const capture = keepSlot(
      this.providers.capture,
      built.capture,
      this.plan.capture,
      freshPlan.capture,
    );
    const windows = keepSlot(
      this.providers.windows,
      built.windows,
      this.plan.windows,
      freshPlan.windows,
    );
    const clipboard = keepSlot(
      this.providers.clipboard,
      built.clipboard,
      this.plan.clipboard,
      freshPlan.clipboard,
    );
    // The idle source follows the same rule: an existing one keeps watching —
    // the arbiter holds it — and an unused fresh one is disposed, since it can
    // hold a helper share of its own.
    const seatIdle = this.providers.seatIdle ?? built.seatIdle;
    if (built.seatIdle !== undefined && built.seatIdle !== seatIdle) {
      void built.seatIdle.dispose();
    }
    this.probe = fresh;
    this.plan = {
      input: input.choice,
      capture: capture.choice,
      windows: windows.choice,
      clipboard: clipboard.choice,
    };
    this.providers = {
      input: input.slot,
      capture: capture.slot,
      windows: windows.slot,
      clipboard: clipboard.slot,
      ...(seatIdle !== undefined ? { seatIdle } : {}),
    };
    // The derived views must follow the providers they were derived from, or
    // status and seat arbitration keep describing the set this backend no
    // longer calls: the exact staleness this merge exists to prevent.
    const capabilities = capabilitiesFromProviders(this.providers);
    const capabilitiesChanged = !sameComputerCapabilities(capabilities, this.capabilitySet);
    this.capabilitySet = capabilities;
    if (this.arbiter === undefined && seatIdle !== undefined && this.capabilitySet.sharedSeat) {
      this.arbiter = new SharedSeatArbiter({ source: seatIdle, now: () => this.now() });
      // A brand-new arbiter has never sampled the seat; the next perception
      // primes it exactly as the first one primed its predecessor.
      this.seatPrimed = false;
    }
    // The manager caches the capability set and publishes it with every thread
    // state; without this it would keep saying the desktop can do nothing.
    if (capabilitiesChanged) {
      this.emit({ type: "capabilities-changed", capabilities: this.capabilitySet });
    }
    this.healthState.publish();
  }

  /**
   * The establishing read: something is about to use the desktop, which is
   * the licence to install the shipped helper the passive probe refused to,
   * and — where a `provisionHelper` is wired — to compile one when nothing
   * shipped fits. Then it answers from what actually resolved.
   */
  async availability(): Promise<ComputerAvailability> {
    await this.resolveHelperIfMissing();
    const failure = await this.ensureProvisioned();
    return this.currentAvailability(failure === undefined ? {} : { provisionFailure: failure });
  }

  /**
   * Provision on demand, for the Computer settings panel's setup action.
   *
   * Discards the memoized answer rather than returning it: a user pressing the
   * button has usually just installed the packages the last attempt named, and
   * handing them that same failure back would be absurd. An attempt still in
   * flight is joined rather than raced — see `startProvision`.
   */
  async provision(): Promise<string> {
    this.throwIfDisposed();
    if (!this.provisionHelper) {
      throw new ComputerBackendError("This backend has no desktop helper to install.", {
        retryable: false,
      });
    }
    this.provisionPromise = undefined;
    const result = await this.startProvision();
    await this.reprobeNow();
    return result.summary;
  }

  /**
   * The verdict both reads share. `passive` marks the boot-time probe, which
   * may answer "available" on the strength of a helper that could be produced;
   * `provisionFailure` carries the establishing read's own reason for a helper
   * that still is not there.
   */
  private async currentAvailability(
    options: { readonly passive?: boolean; readonly provisionFailure?: string } = {},
  ): Promise<ComputerAvailability> {
    // The panel reads this on every render of a thread state, which makes it
    // the natural place for a throttled catch-up with the desktop.
    await this.refreshCapabilitiesIfStale();
    if (this.platform !== "linux") {
      return { kind: "unsupported-platform", platform: this.platform };
    }
    if (this.probe.sessionType !== "wayland") {
      return {
        kind: "backend-unavailable",
        message:
          this.probe.sessionType === ""
            ? "Linux computer control requires a graphical session, and this server is not in one."
            : `Linux computer control requires a Wayland session; this is an ${this.probe.sessionType} session.`,
      };
    }
    // Perception and action are the floor: a desktop that can supply neither is
    // not a desktop Synara can drive, whatever else resolved. Windows and
    // clipboard missing is a degraded but usable backend — the agent works in
    // desktop coordinates — so it does not fail availability, only capability.
    const blockers = [
      describeSlot("Input", this.providers.input),
      describeSlot("Screen capture", this.providers.capture),
    ].filter((message): message is string => message !== undefined);
    const helperMayArrive =
      blockers.length > 0 &&
      options.passive === true &&
      this.probe.helperBinary === undefined &&
      (await this.helperCouldExist());
    if (blockers.length > 0 && !helperMayArrive) {
      // The provisioning failure wins when there is one: "this machine is
      // missing gcc" is actionable, where the plan's refusal can only say the
      // helper is absent without knowing why installing it did not work. It is
      // also error text this backend does not control — a compiler diagnostic,
      // a checksum mismatch — so it is clamped to the contract's message bound
      // rather than allowed to fail the state payload carrying it.
      return {
        kind: "backend-unavailable",
        message: clampComputerMessage(
          options.provisionFailure ?? blockers.join(" "),
          UNAVAILABLE_FALLBACK_MESSAGE,
        ),
      };
    }
    // A denied dialog blocks availability with the reason and its remedy — the
    // one blocker whose fix is a decision rather than a package. `awaiting`
    // deliberately stays available: the dialog is up and health says so.
    if (this.consent === "denied") {
      return {
        kind: "backend-unavailable",
        message:
          this.consentReason ??
          "The desktop's permission dialog was dismissed, so Synara has no remote-control grant. " +
            'Use "Ask for permission again" in the Computer panel to be asked once more.',
      };
    }
    return { kind: "available", backend: "portal" };
  }

  private async helperCouldExist(): Promise<boolean> {
    if (!this.couldProvisionHelper) return false;
    return await this.couldProvisionHelper().catch(() => false);
  }

  /**
   * Runs provisioning at most once per backend, resolving to the failure
   * message if there was one.
   *
   * Memoized the way `KWinComputerBackend.provisionPromises` is, and for the
   * same reason: every tool call goes through `availability()`, and a compile
   * that takes seconds must not be started once per call. The two outcomes
   * memoize differently. Success sticks for the life of the process — the
   * stamp check ran and passed, and re-hashing the helper sources on every
   * tool call buys nothing. Failure clears itself (see `runProvision`): the
   * usual cause is a missing package the message names, and the user who just
   * installed it must not be handed the memoized refusal.
   *
   * A helper already on disk is deliberately not a reason to skip: the stamp
   * check inside provisioning is the only thing that notices an installed
   * helper gone stale against the sources this build shipped, and it is cheap
   * when nothing changed.
   */
  private ensureProvisioned(): Promise<string | undefined> {
    if (this.disposed) return Promise.resolve(undefined);
    if (!this.provisionHelper) return Promise.resolve(undefined);
    this.provisionPromise ??= this.runProvision();
    return this.provisionPromise;
  }

  private async runProvision(): Promise<string | undefined> {
    try {
      const result = await this.startProvision();
      // "Already current" with the helper already probed means nothing about
      // this desktop changed, and re-probing would spawn the helper to re-read
      // a registry the plan already reflects. Every other outcome — a fresh
      // install, or a helper the construction probe did not see — changes what
      // the desktop can do, so the probe is retaken at once.
      if (result.action !== "already-current" || this.probe.helperBinary === undefined) {
        await this.reprobeNow();
      }
      return undefined;
    } catch (error) {
      // A failed attempt is a fact about that attempt, not about this machine
      // forever. Clearing the memo is what makes the next availability() retry
      // after the user installs the package the message names.
      this.provisionPromise = undefined;
      return describeErrorMessage(error, "installing the desktop helper failed without a reason.");
    }
  }

  /**
   * The install itself, deduplicated across every path that can start one.
   *
   * `availability()` and the settings panel's `provision()` can race — a tool
   * call arriving while the user presses "Set up" — and two concurrent
   * installs would collide in the staging directory. Whoever asks while one is
   * in flight joins it and shares its outcome.
   */
  private startProvision(): Promise<DesktopHelperProvisionResult> {
    const provisionHelper = this.provisionHelper;
    if (!provisionHelper) {
      return Promise.reject(
        new ComputerBackendError("This backend has no desktop helper to install.", {
          retryable: false,
        }),
      );
    }
    this.provisionInFlight ??= Promise.resolve()
      .then(provisionHelper)
      .finally(() => {
        this.provisionInFlight = undefined;
      });
    return this.provisionInFlight;
  }

  /**
   * The human-driven recovery from a dismissed permission dialog: clears the
   * denied latch here and on the session behind every consent-bearing
   * provider, so the next action asks once more. Returns whether anything was
   * latched — a desktop with no denial has nothing to recover.
   */
  resetConsent(): boolean {
    if (this.disposed || this.consent !== "denied") return false;
    for (const slot of [this.providers.input, this.providers.capture, this.providers.clipboard]) {
      if (slot.available) slot.provider.resetDeniedConsent?.();
    }
    // The session callback has normally cleared this already; covering the
    // case where no live provider carries the session keeps the latch from
    // surviving its own reset.
    if (this.consent === "denied") this.setConsentState("not-requested");
    return true;
  }

  /**
   * Health as the supervision path already knows it: no D-Bus call, no probe.
   * `awaiting-consent` outranks everything else that is true at the same time,
   * because it is the only state whose remedy is a user action rather than a
   * retry, and a panel that showed `reconnecting` instead would have the user
   * waiting on a dialog nobody is going to answer.
   */
  health(): ComputerHealth {
    return this.healthState.health();
  }

  /** Where the desktop's permission dialog stands, and why if it is not moving. */
  consentState(): { readonly state: PortalConsentState; readonly reason?: string } {
    return this.consentReason === undefined
      ? { state: this.consent }
      : { state: this.consent, reason: this.consentReason };
  }

  /**
   * Moves the consent state and republishes health.
   *
   * A denial latches here rather than at the call site so every path that can
   * see one — the first mutating action, the first pane attach, a restore token
   * that stopped working — latches identically.
   */
  setConsentState(state: PortalConsentState, reason?: string): void {
    if (this.consent === "denied" && state !== "not-requested") return;
    const granted = state === "granted" && this.consent !== "granted";
    this.consent = state;
    this.consentReason = reason;
    // Re-armed on the transition into a grant, not only at first perception: on
    // the portal desktops the idle monitor is the same gnome-shell the dialog
    // was blocking, and the arm that ran when the agent first looked at the
    // screen may have been refused or gone stale while the user was deciding.
    if (granted) {
      this.seatPrimed = true;
      this.arbiter?.prime();
    }
    this.healthState.publish();
  }

  /**
   * Arms the seat's idle notification the first time the agent looks at the
   * desktop, not at construction: the backend is built when the server boots,
   * and on a wlroots desktop the arbiter's first sample is what spawns the
   * helper process. Perception is the arm point because it reliably precedes
   * the first mutation by more than the notification's blind window. A mutation
   * with nothing before it meets the guard's own sample instead, which refuses
   * retryably while the source is still blind — slower, but never wrong.
   */
  private primeSeatArbiterOnce(): void {
    if (this.seatPrimed) return;
    this.seatPrimed = true;
    this.arbiter?.prime();
  }

  async listWindows(): Promise<readonly ComputerWindow[]> {
    this.throwIfDisposed();
    this.primeSeatArbiterOnce();
    return await this.readWindows(await this.agentOrigin());
  }

  private async readWindows(origin: ComputerPoint): Promise<readonly ComputerWindow[]> {
    const provider = requireProvider(this.providers.windows, "Listing windows");
    return (await provider.listWindows()).map((window) => windowInAgentSpace(window, origin));
  }

  /**
   * The origin agent coordinates translate by, refreshed from the capture
   * provider's workspace when there is one. Window bounds share the capture
   * provider's layout space, so its workspace top-left is the one true origin;
   * without a capture provider the cached value is the best there is.
   */
  private async agentOrigin(): Promise<ComputerPoint> {
    if (this.providers.capture.available) await this.workspaceRect();
    return this.lastAgentOrigin;
  }

  async getScreenSize(): Promise<ComputerScreenSize> {
    this.throwIfDisposed();
    this.primeSeatArbiterOnce();
    const rect = await this.workspaceRect();
    return { width: rect.width, height: rect.height, scale: 1 };
  }

  /**
   * Full perception. Requires the window provider even though the screenshot
   * alone would be useful, because `ComputerState.windows` is a required array
   * with no way to express "unknown": filling it with `[]` on a desktop that
   * cannot enumerate is precisely the lie this tier is built to avoid. The
   * coordinate-only workflow on such a desktop is `getScreenSize` plus
   * `captureScreenshot({ kind: "region" })`, neither of which needs windows.
   */
  async getState(options: {
    readonly includeScreenshot?: boolean;
    readonly includeText?: boolean;
  }): Promise<ComputerState> {
    this.throwIfDisposed();
    this.primeSeatArbiterOnce();
    const rect = await this.workspaceRect();
    const windows = await this.readWindows(this.lastAgentOrigin);
    const screenshot = options.includeScreenshot
      ? await this.captureRect(
          { x: 0, y: 0, width: rect.width, height: rect.height },
          this.captureMaxDimension,
        )
      : undefined;
    return {
      computerId: this.computerId,
      windows,
      screenSize: { width: rect.width, height: rect.height, scale: 1 },
      ...(screenshot ? { screenshot } : {}),
      capturedAt: new Date(this.now()).toISOString(),
    };
  }

  async captureScreenshot(request: ComputerCaptureRequest): Promise<ComputerScreenshot> {
    this.throwIfDisposed();
    this.primeSeatArbiterOnce();
    const maxDimension = normalizeDimension(request.maxDimension, this.captureMaxDimension);
    if (request.kind === "window") {
      const windows = await this.listWindows();
      const window = windows.find((candidate) => candidate.id === request.windowId);
      if (!window) {
        throw new ComputerBackendError(
          `No window with id ${JSON.stringify(request.windowId)} is open.`,
        );
      }
      return await this.captureRect(
        requireWindowBounds(window, "a window screenshot"),
        maxDimension,
      );
    }
    return await this.captureRect(request.region, maxDimension);
  }

  /**
   * Guarded even though it injects no input: a launched app maps a window,
   * takes focus, and moves what the human is typing into. That is the seat
   * changing under them, which is what the arbiter is for.
   */
  async launchApp(app: string, args: readonly string[]): Promise<ComputerLaunchAppResult> {
    this.throwIfDisposed();
    const launch = this.resolveApp(app, args);
    await this.guarded(async () => {
      const child = this.spawnProcess(launch.command, launch.args);
      child.unref?.();
      await new Promise<void>((resolve, reject) => {
        const settle = () => {
          child.off("error", onError);
          child.off("spawn", onSpawn);
        };
        const onError = (error: Error) => {
          settle();
          reject(
            new ComputerBackendError(`Launching ${app} failed: ${error.message}`, { cause: error }),
          );
        };
        const onSpawn = () => {
          settle();
          resolve();
        };
        child.once("error", onError);
        child.once("spawn", onSpawn);
      });
    });
    // The window is reported only where enumeration exists. `null` here means
    // "not looked up", which `capabilities.windows === false` already says; the
    // alternative — refusing the launch — would remove a capability that works.
    return { computerId: this.computerId, app, resolvedCommand: launch.command, window: null };
  }

  async click(point: ComputerPoint): Promise<ComputerBackendActionResult> {
    return await this.clickWithButton(point, EVDEV_BUTTON_CODES.left, 1);
  }

  async doubleClick(point: ComputerPoint): Promise<ComputerBackendActionResult> {
    return await this.clickWithButton(point, EVDEV_BUTTON_CODES.left, 2);
  }

  async rightClick(point: ComputerPoint): Promise<ComputerBackendActionResult> {
    return await this.clickWithButton(point, EVDEV_BUTTON_CODES.right, 1);
  }

  async moveCursor(point: ComputerPoint): Promise<ComputerBackendActionResult> {
    await this.guarded(() => this.glidePointer(point, this.glideDurationMs));
    return { point };
  }

  async drag(
    from: ComputerPoint,
    to: ComputerPoint,
    durationMs: number,
  ): Promise<ComputerBackendActionResult> {
    const input = this.requireInput("Dragging");
    // Guarded once around the whole gesture, not per segment: a drag that gave
    // way half way through would leave the button down over someone else's
    // window, which is worse than either finishing or never starting.
    await this.guarded(async () => {
      await this.glidePointer(from, this.glideDurationMs);
      await input.sink.button(
        EVDEV_BUTTON_CODES.left,
        true,
        POINTER_SEQUENCE_OPERATIONS.buttonPress,
      );
      try {
        await this.glidePointer(to, durationMs);
      } finally {
        await input.sink.button(
          EVDEV_BUTTON_CODES.left,
          false,
          POINTER_SEQUENCE_OPERATIONS.buttonRelease,
        );
      }
    });
    return { point: to };
  }

  async scroll(
    point: ComputerPoint | null,
    deltaX: number,
    deltaY: number,
  ): Promise<ComputerBackendActionResult> {
    const input = this.requireInput("Scrolling");
    await this.guarded(async () => {
      if (point) await this.glidePointer(point, this.glideDurationMs);
      await input.scroll(deltaX, deltaY);
    });
    return point ? { point } : {};
  }

  async typeText(text: string): Promise<ComputerBackendActionResult> {
    const input = this.requireInput("Typing");
    await this.guarded(async () => {
      for (const stroke of qwertyTextKeyStrokes(text)) {
        this.throwIfDisposed();
        await pressKeyStroke({ sink: input.sink, stroke });
      }
    });
    return {};
  }

  async pressKey(key: string): Promise<ComputerBackendActionResult> {
    const input = this.requireInput("Pressing a key");
    await this.guarded(() => pressKeyStroke({ sink: input.sink, stroke: keyStrokeForKey(key) }));
    return {};
  }

  async hotkey(keys: readonly string[]): Promise<ComputerBackendActionResult> {
    const input = this.requireInput("Pressing a hotkey");
    await this.guarded(() =>
      pressHotkeyStrokes({ sink: input.sink, strokes: keys.map(keyStrokeForKey) }),
    );
    return {};
  }

  async focusWindow(windowId: string): Promise<void> {
    const provider = requireProvider(this.providers.windows, "Focusing a window");
    if (!provider.activateWindow) {
      throw new ComputerBackendError(
        `This desktop's window provider (${provider.id}) reports windows but cannot activate them, ` +
          "so keyboard focus cannot be moved to a window. Type after clicking into the window instead.",
        { retryable: false },
      );
    }
    // Activation is the one window operation that takes the human's keyboard
    // focus away mid-sentence, so it yields. `raiseWindow` deliberately does
    // not: restacking without focus is how a covered window is read.
    const activateWindow = provider.activateWindow.bind(provider);
    await this.guarded(() => activateWindow(windowId));
  }

  async raiseWindow(windowId: string): Promise<void> {
    const provider = requireProvider(this.providers.windows, "Raising a window");
    if (!provider.raiseWindow) {
      throw new ComputerBackendError(
        `This desktop's window provider (${provider.id}) exposes no stacking control, so a window ` +
          "cannot be raised above the ones covering it. Activate it instead, which may also move the human's focus.",
        { retryable: false },
      );
    }
    await provider.raiseWindow(windowId);
  }

  async readClipboard(): Promise<string> {
    const provider = requireProvider(this.providers.clipboard, "Reading the clipboard");
    const text = await provider.read();
    return clampClipboard(text);
  }

  async writeClipboard(text: string): Promise<void> {
    const provider = requireProvider(this.providers.clipboard, "Writing the clipboard");
    // The clipboard is one buffer for both participants: overwriting it is
    // taking something out of the human's hand, so it yields. Reading does not.
    await this.guarded(() => provider.write(clampClipboard(text)));
  }

  /**
   * Semantic targeting has no provider slot because it is not a display-server
   * capability: AT-SPI is a separate bus service and is wired per phase. Until
   * then a label-targeted action refuses by name rather than silently becoming
   * a click at whatever coordinate the resolver guessed.
   */
  setValue(target: ComputerResolvedTarget, _value: string): Promise<never> {
    return Promise.reject(this.unsupportedSemanticAction("Setting a value", target));
  }

  performAction(target: ComputerResolvedTarget, action: string): Promise<never> {
    return Promise.reject(this.unsupportedSemanticAction(`The ${action} action`, target));
  }

  onEvent(listener: ComputerBackendEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async attachStream(listener: ComputerFrameListener): Promise<void> {
    this.throwIfDisposed();
    this.primeSeatArbiterOnce();
    // Fail before subscribing rather than after: a pane that attaches to a
    // stream that can never produce a frame shows a spinner with no error.
    requireProvider(this.providers.capture, "Streaming the screen");
    if (this.streamTimer !== undefined) clearInterval(this.streamTimer);
    this.streamListener = listener;
    await this.publishStillFrame();
    this.streamTimer = setInterval(() => {
      void this.publishStillFrame();
    }, this.stillIntervalMs);
    this.streamTimer.unref?.();
  }

  detachStream(): Promise<void> {
    this.streamListener = undefined;
    if (this.streamTimer !== undefined) clearInterval(this.streamTimer);
    this.streamTimer = undefined;
    return Promise.resolve();
  }

  async requestKeyframe(): Promise<void> {
    if (!this.streamListener) return;
    await this.publishStillFrame();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.detachStream();
    await disposeProviderSet(this.providers);
    this.eventListeners.clear();
  }

  private healthStatus(): ComputerHealth["status"] {
    if (this.consent === "awaiting") return "awaiting-consent";
    if (this.consent === "denied") return "consent-denied";
    return this.providers.input.available && this.providers.capture.available
      ? "connected"
      : "unavailable";
  }

  private requireInput(attempted: string) {
    this.throwIfDisposed();
    return requireProvider(this.providers.input, attempted);
  }

  private async clickWithButton(
    point: ComputerPoint,
    code: number,
    times: number,
  ): Promise<ComputerBackendActionResult> {
    const input = this.requireInput("Clicking");
    // One guard for the whole click, including the glide that positions it:
    // click, doubleClick, and rightClick all arrive here, and a double-click
    // whose second press was refused is a single click the agent thinks landed.
    await this.guarded(async () => {
      await this.glidePointer(point, this.glideDurationMs);
      for (let index = 0; index < times; index += 1) {
        await pressButtonOnce({ sink: input.sink, code, sleep: this.sleep });
      }
    });
    return { point };
  }

  /**
   * One mutating action, given way if the human is using the seat.
   *
   * Every mutating path goes through here rather than calling the arbiter
   * directly, so the "guard before, note after" ordering exists once and the
   * health republish that drives the panel's "waiting for you" copy cannot be
   * forgotten at a call site. Perception never comes here.
   *
   * `publish` only emits on a real change, so the common case — the seat was
   * quiet and still is — puts nothing on the wire.
   */
  private async guarded<T>(run: () => Promise<T>): Promise<T> {
    const arbiter = this.arbiter;
    if (!arbiter) return await run();
    try {
      return await arbiter.guarded(run);
    } finally {
      this.healthState.publish();
    }
  }

  /**
   * The arbiter's account of the human, as health. Absent when there is no
   * arbiter, which is how a dedicated seat and an unwatchable one are told
   * apart from a shared seat that is simply quiet.
   */
  private seatHealth(): ComputerSeatHealth | undefined {
    const status = this.arbiter?.status();
    if (!status) return undefined;
    return {
      observing: status.observing,
      // Clamped because the reason is a compositor's or a helper's own error
      // text, and it goes onto a length-bounded state payload.
      ...(status.reason === undefined
        ? {}
        : {
            reason: clampComputerMessage(
              status.reason,
              "The shared seat's idle state could not be read.",
            ),
          }),
      ...(status.lastYieldAt === undefined
        ? {}
        : { lastYieldAt: new Date(status.lastYieldAt).toISOString() }),
    };
  }

  /**
   * Not guarded, and called only from inside a guarded action. Guarding each
   * segment of a glide would refuse mid-gesture — a human who arrives during a
   * drag would strand the pointer with the button down — so the whole gesture
   * is one decision, taken before it starts.
   */
  private async glidePointer(to: ComputerPoint, durationMs: number): Promise<void> {
    const input = this.requireInput("Moving the pointer");
    // One origin per gesture, read from the freshest workspace this backend
    // has seen: the sink speaks global layout coordinates, the glide plans in
    // agent space, and a mid-glide workspace change must not bend the path.
    const origin = this.lastAgentOrigin;
    const reported = (await input.pointerPosition?.()) ?? null;
    const from = this.currentPoint ?? (reported ? shiftPoint(reported, -origin.x, -origin.y) : to);
    await glidePointerToDeadline({
      sink: {
        movePointer: (x, y, operation) =>
          input.sink.movePointer(x + origin.x, y + origin.y, operation),
      },
      from,
      to,
      durationMs,
      now: () => this.now(),
      sleep: this.sleep,
      beforeStep: () => this.throwIfDisposed(),
      onStep: (point) => {
        this.currentPoint = point;
      },
    });
    this.currentPoint = to;
  }

  private async workspaceRect(): Promise<ComputerRect> {
    const provider = requireProvider(this.providers.capture, "Reading the screen size");
    const rect = alignRect(await provider.workspaceRect());
    this.lastAgentOrigin = { x: rect.x, y: rect.y };
    return rect;
  }

  /**
   * Captures an agent-space region. The provider speaks the desktop's global
   * layout space, so the request shifts by the workspace origin on the way in
   * and the captured region shifts back on the way out; the refusal message
   * stays in agent space because that is the only space the caller ever sees.
   */
  private async captureRect(
    region: ComputerRect,
    maxDimension: number,
  ): Promise<ComputerScreenshot> {
    const provider = requireProvider(this.providers.capture, "Capturing the screen");
    const workspace = alignRect(await provider.workspaceRect());
    const origin = { x: workspace.x, y: workspace.y };
    this.lastAgentOrigin = origin;
    const requested = alignRect(region);
    const clipped = intersectComputerRects(shiftRect(requested, origin.x, origin.y), workspace);
    if (!clipped) {
      throw new ComputerBackendError(
        `The requested capture region ${formatRect(requested)} lies outside the desktop ${formatRect(shiftRect(workspace, -origin.x, -origin.y))}.`,
      );
    }
    const captured = await provider.captureRegion(clipped, maxDimension);
    return screenshotFromPng({
      bytes: captured.bytes,
      region: shiftRect(captured.region, -origin.x, -origin.y),
      capturedAt: new Date(this.now()).toISOString(),
      source: CAPTURE_SOURCE,
    });
  }

  private async publishStillFrame(): Promise<void> {
    const listener = this.streamListener;
    if (!listener || this.disposed || this.stillInFlight) return;
    this.stillInFlight = true;
    try {
      const rect = await this.workspaceRect();
      const screenshot = await this.captureRect(
        { x: 0, y: 0, width: rect.width, height: rect.height },
        this.captureMaxDimension,
      );
      if (this.streamListener !== listener) return;
      const frame = {
        sequence: this.nextSequence++,
        timestampMs: this.now(),
        // Every frame is a complete PNG still, as in Tier 1: there is no codec
        // config or delta frame, so the envelope stays keyframe-only.
        keyframe: true,
        codecConfig: false,
        data: Uint8Array.from(Buffer.from(screenshot.bytesBase64, "base64")),
      };
      listener(frame);
      this.emit({ type: "frame", frame });
    } catch {
      // A transient capture failure must not tear down a subscribed stream.
    } finally {
      this.stillInFlight = false;
    }
  }

  private unsupportedSemanticAction(
    attempted: string,
    target: ComputerResolvedTarget,
  ): ComputerBackendError {
    return new ComputerBackendError(
      `${attempted} on ${JSON.stringify(target.node.label ?? target.node.role)} needs accessibility-tree access, ` +
        "which the portal backend does not wire up yet. Click the control at its coordinates instead.",
      { retryable: false },
    );
  }

  private throwIfDisposed(): void {
    if (this.disposed) {
      throw new ComputerBackendError("The portal computer backend has been disposed.");
    }
  }

  private emit(event: ComputerBackendEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }
}

/**
 * Capabilities from what resolved, plus the two questions only the window
 * provider can answer. `sharedSeat` comes off the input provider rather than
 * being assumed true for the tier, because it is what the panel's
 * shared-control warning keys off and getting it wrong in either direction
 * misleads the user about whose cursor is moving.
 */
export function capabilitiesFromProviders(providers: PortalProviders): ComputerCapabilities {
  const windows = providers.windows.available ? providers.windows.provider : undefined;
  const input = providers.input.available ? providers.input.provider : undefined;
  return {
    windows: windows !== undefined,
    windowBounds: windows?.providesBounds === true,
    stacking: windows?.providesStacking === true,
    capture: providers.capture.available,
    input: input !== undefined,
    clipboard: providers.clipboard.available,
    activation: windows?.activateWindow !== undefined || windows?.raiseWindow !== undefined,
    // No Tier 2 mechanism can draw a second pointer: there is no second seat on
    // a portal or wlroots desktop, and a layer-shell marker is decoration.
    ghostCursor: false,
    sharedSeat: input?.sharedSeat === true,
    // Tier 2 always drives the human's live session — portals and wlroots
    // protocols have no notion of an offscreen desktop.
    visibleDesktop: true,
  };
}

export interface GnomeShellProviderOptions {
  /** Test seam: swaps the session-bus proxy for a fake extension. */
  readonly connectGnomeShellExtension?: GnomeShellExtensionConnect;
}

/** Everything the provider families need, in one bag. */
export type PortalProviderOptions = WlrootsProviderOptions &
  PortalSessionProviderOptions &
  GnomeShellProviderOptions;

/**
 * The providers a probe resolves today.
 *
 * Three families are built here. The wlroots set — virtual input, screencopy,
 * foreign-toplevel — plus the wl-clipboard provider, on desktops that advertise
 * the protocols and have the native helper. The portal-session set —
 * RemoteDesktop input, portal-selection clipboard — on desktops whose only
 * mechanism is a consent-gated portal, which today means GNOME. And the GNOME
 * Shell extension, which is the only thing that can answer "what windows exist"
 * on mutter. They are mutually exclusive per slot by construction, because the
 * plan picks exactly one implementation for each.
 *
 * Everything still unbuilt (PipeWire capture) leaves its slot to the sentence
 * the plan produced: the provider this desktop *would* use and the package or
 * phase that is actually missing. A user is never told "unsupported" when the
 * true answer is "install this" or "not written yet".
 */
export function resolvePortalProviders(
  probe: PortalProbe,
  options: PortalProviderOptions = {},
): PortalProviders {
  const plan = planPortalProviders(probe);
  const wlroots = resolveWlrootsProviders(probe, plan, options);
  const session = resolvePortalSessionProviders(probe, plan, options);
  const seatIdle = pickSeatIdle(wlroots, session);
  const built = {
    ...wlroots,
    ...session,
    ...resolveGnomeShellWindows(plan, options),
  };
  const slot = <T>(
    resolved: ProviderSlot<T> | undefined,
    blockedBy: string | undefined,
  ): ProviderSlot<T> =>
    resolved ?? missingProvider<T>(blockedBy ?? "No provider is wired up for this capability yet.");
  return {
    input: slot(built.input, plan.input.blockedBy),
    capture: slot(built.capture, plan.capture.blockedBy),
    windows: slot(built.windows, plan.windows.blockedBy),
    clipboard: slot(built.clipboard, plan.clipboard.blockedBy),
    ...(seatIdle ? { seatIdle } : {}),
  };
}

/**
 * Closes every provider in a set, whether it is being replaced or the backend
 * is going away.
 *
 * Disposal order does not matter between providers, but a provider that throws
 * must not strand the others: the portal session and the EIS fd are the kill
 * switch, so every one of them gets its chance to close.
 */
async function disposeProviderSet(providers: PortalProviders): Promise<void> {
  const slots = [providers.input, providers.capture, providers.windows, providers.clipboard];
  await Promise.allSettled([
    ...slots.map((slot) => (slot.available ? slot.provider.dispose() : Promise.resolve())),
    // Disposed with the rest: on wlroots it holds a share of the same helper
    // the three Wayland-native providers do, so skipping it would leave the
    // process attached to the compositor forever.
    providers.seatIdle?.dispose() ?? Promise.resolve(),
  ]);
}

/** Field-wise equality, for deciding whether a reprobe moved a capability. */
function sameComputerCapabilities(
  left: ComputerCapabilities,
  right: ComputerCapabilities,
): boolean {
  return (Object.keys(left) as ReadonlyArray<keyof ComputerCapabilities>).every(
    (key) => left[key] === right[key],
  );
}

/**
 * The one idle source to keep, with the other disposed rather than dropped.
 *
 * Both families can produce one — a desktop can take input from the portal
 * while the helper is still running for capture — and the wlroots source holds
 * a share of that helper process. Dropping it unreleased would keep the helper
 * attached to the compositor for the server's lifetime. The helper-backed
 * source wins where both exist: it watches the seat over the connection the
 * providers already depend on, with no second bus service in the way.
 */
function pickSeatIdle(
  wlroots: Partial<PortalProviders>,
  session: Partial<PortalProviders>,
): PortalProviders["seatIdle"] {
  const kept = wlroots.seatIdle ?? session.seatIdle;
  for (const candidate of [wlroots.seatIdle, session.seatIdle]) {
    if (candidate && candidate !== kept) void candidate.dispose();
  }
  return kept;
}

/**
 * Windows on GNOME, through the Shell extension.
 *
 * Resolved here rather than with the portal-session providers because it shares
 * nothing with them: the extension is an ordinary bus service, it needs no
 * consent, and a desktop can have the extension installed with the portal grant
 * still outstanding. `DBUS_SESSION_BUS_ADDRESS` is taken from the same `env` the
 * other providers address an isolated session with, so a nested session reaches
 * its own extension rather than the human's.
 */
function resolveGnomeShellWindows(
  plan: PortalProviderPlan,
  options: PortalProviderOptions,
): Pick<Partial<PortalProviders>, "windows"> {
  if (!usesProvider(plan, "windows", "gnome-shell-extension")) return {};
  const busAddress = options.env?.DBUS_SESSION_BUS_ADDRESS;
  return {
    windows: resolvedProvider<PortalWindowProvider>(
      new GnomeShellWindowProvider({
        connect:
          options.connectGnomeShellExtension ??
          (() => connectGnomeShellExtension(busAddress ? { busAddress } : {})),
      }),
    ),
  };
}

/**
 * Builds the Tier 2 backend for an already-probed desktop.
 *
 * The consent wiring is the one piece of ordering that matters. The portal
 * session reports where the dialog stands, but the state machine — including
 * the denial latch and the health projection — belongs to the backend, and the
 * backend does not exist until its providers do. So the callback is installed
 * first and resolves the backend when it fires, which is always later: nothing
 * opens a session during construction.
 */
export function createPortalComputerBackend(
  probe: PortalProbe,
  options: Omit<PortalComputerBackendOptions, "probe" | "providers"> & {
    readonly providers?: PortalProviders;
    /** Passed to the providers; a nested session supplies its display here. */
    readonly providerOptions?: PortalProviderOptions;
  } = {},
): PortalComputerBackend {
  const { providers, providerOptions, ...rest } = options;
  let backend: PortalComputerBackend | undefined;
  // Named once and reused for the initial set and for every rebuild, so a
  // provider set built after a reprobe is wired to consent exactly the way the
  // first one was.
  const buildProviders = (probeForProviders: PortalProbe): PortalProviders =>
    resolvePortalProviders(probeForProviders, {
      ...providerOptions,
      onConsentChanged: (state, reason) => {
        backend?.setConsentState(state, reason);
        providerOptions?.onConsentChanged?.(state, reason);
      },
      onSessionClosed: (reason) => {
        providerOptions?.onSessionClosed?.(reason);
      },
    });
  const resolved = providers ?? buildProviders(probe);
  backend = new PortalComputerBackend({
    ...rest,
    probe,
    providers: resolved,
    // Re-probing and installing a shipped helper default to this host: both
    // read what is already there, and the install copies a checksummed binary
    // or does nothing. Compiling one (`provisionHelper`) is not defaulted: this
    // factory cannot tell a probe of this machine from a desktop a caller made
    // up, and a unit test must not build a helper onto the developer's laptop.
    // The caller that knows the probe came from this host supplies it.
    recomputeProbe: rest.recomputeProbe ?? (() => probeDesktop()),
    buildProviders,
    resolveHelper: rest.resolveHelper ?? (() => resolveDesktopHelper()),
  });
  return backend;
}

function describeSlot(capability: string, slot: ProviderSlot<unknown>): string | undefined {
  return slot.available ? undefined : `${capability} is unavailable. ${slot.reason}`;
}

/**
 * Clipboards hold whole documents, so both directions need a ceiling: without
 * one a read would stream unbounded data into a turn and a write would pipe it
 * back out.
 */
function clampClipboard(text: string): string {
  return clampUtf8Bytes(text, MAX_COMPUTER_CLIPBOARD_BYTES);
}

/**
 * A capture ceiling that is a real number of pixels.
 *
 * The finite check is the load-bearing half. `maxDimension` reaches here from a
 * tool call, and `Math.max(1, Math.min(32768, Math.floor(NaN)))` is `NaN`, which
 * then flows into `captureRegion` as a scale factor and produces a request for a
 * NaN-by-NaN image rather than a refusal. The same normalisation exists as
 * `normalizeDimension` on the KWin backend; the two clamps must agree, because
 * a screenshot has to mean the same thing on both.
 */
function normalizeDimension(
  value: number | undefined,
  fallback: number = DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION,
): number {
  const requested = value ?? fallback;
  if (!Number.isFinite(requested)) return fallback;
  return Math.max(1, Math.min(32_768, Math.floor(requested)));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}
