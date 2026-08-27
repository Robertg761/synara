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
import {
  planPortalProviders,
  usesProvider,
  type PortalProbe,
  type PortalProviderChoice,
  type PortalProviderPlan,
} from "./probe.ts";
import {
  missingProvider,
  PORTAL_CAPABILITY_SLOTS,
  requireProvider,
  resolvedProvider,
  type PortalCapabilitySlot,
  type PortalProviderId,
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
   * Whether this desktop needs a consent dialog at all. wlroots grants nothing
   * and prompts for nothing, so its consent state starts and stays
   * `not-required`; GNOME's portal starts at `not-requested`.
   */
  readonly consent?: PortalConsentState;
  /**
   * Installs or compiles the desktop helper. Absent in tests and in nested
   * sessions, where the helper is supplied by whatever started the compositor.
   */
  readonly provisionHelper?: () => Promise<DesktopHelperProvisionResult>;
  /** Whether provisioning could plausibly succeed, asked without doing it. */
  readonly couldProvisionHelper?: () => Promise<boolean>;
  /** Takes a fresh probe of the same desktop, after provisioning changed it. */
  readonly reprobe?: () => Promise<PortalProbe>;
  /** Rebuilds the provider set for a probe whose answer changed. */
  readonly buildProviders?: (probe: PortalProbe) => PortalProviders;
}

export class PortalComputerBackend implements ComputerBackend {
  readonly computerId: ComputerId;

  /**
   * Replaced when provisioning installs a helper this desktop did not have.
   * Everything derived from the probe — the plan, the providers, the capability
   * set, the arbiter — is replaced with it, because all four are pure functions
   * of the probe and a half-updated set would report capabilities the providers
   * cannot serve.
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
  private readonly healthState: ComputerHealthState;
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
  private streamListener: ComputerFrameListener | undefined;
  private streamTimer: ReturnType<typeof setInterval> | undefined;
  private stillInFlight = false;
  private nextSequence = 1;
  private readonly provisionHelper: (() => Promise<DesktopHelperProvisionResult>) | undefined;
  private readonly couldProvisionHelper: (() => Promise<boolean>) | undefined;
  private readonly reprobe: (() => Promise<PortalProbe>) | undefined;
  private readonly buildProviders: ((probe: PortalProbe) => PortalProviders) | undefined;
  /** Memoized so concurrent tool calls share one install rather than racing. */
  private provisionPromise: Promise<string | undefined> | undefined;
  /**
   * The install itself, shared between `availability()` and the settings
   * panel's `provision()`. Two concurrent installs would collide in the
   * staging directory, so whoever asks while one is in flight joins it.
   */
  private provisionInFlight: Promise<DesktopHelperProvisionResult> | undefined;
  /**
   * Serializes probe adoption. Two adoptions interleaving would each capture
   * the same previous provider set and dispose it twice, while both of their
   * fresh sets survive — one of them assigned, the other leaked.
   */
  private adoptChain: Promise<void> = Promise.resolve();

  constructor(options: PortalComputerBackendOptions) {
    this.computerId = (options.computerId ?? DEFAULT_COMPUTER_ID) as ComputerId;
    this.probe = options.probe;
    this.plan = planPortalProviders(options.probe);
    this.providers = options.providers;
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
    this.reprobe = options.reprobe;
    this.buildProviders = options.buildProviders;
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
   * "Could this machine drive this desktop?", answered without touching it.
   *
   * Split from `availability()` for the same reason Tier 1 splits them: this
   * runs at server boot and on every render of the settings card, while the
   * establishing read compiles a helper on a cold machine. Nothing here spawns
   * a helper, opens a portal session, or puts a dialog on the user's screen.
   *
   * The one judgement call is the same trade `KWinComputerBackend` documents.
   * A desktop whose only blocker is a helper that does not exist *yet* answers
   * "available", because a shipped binary matches or this machine can compile
   * one. A wrong yes costs the first real use one error card — the same card
   * provisioning already produces — while a wrong no costs the user the feature
   * outright, and, worse, is self-fulfilling: `supported` gates whether the
   * computer tools are offered at all, so a "no" here means nothing ever calls
   * the establishing read that would have fixed the machine.
   */
  async probeAvailability(): Promise<ComputerAvailability> {
    const refusal = this.platformRefusal();
    if (refusal) return refusal;
    const blockers = this.capabilityBlockers();
    if (blockers.length === 0) return { kind: "available", backend: "portal" };
    if (this.probe.helperBinary === undefined && (await this.helperCouldExist())) {
      return { kind: "available", backend: "portal" };
    }
    return {
      kind: "backend-unavailable",
      message: clampComputerMessage(blockers.join(" "), UNAVAILABLE_FALLBACK_MESSAGE),
    };
  }

  /**
   * The establishing read: provisions the helper if that is what this desktop
   * is waiting on, then answers from what actually resolved.
   *
   * Before this existed, Tier 2 had no establishing step at all — this method
   * and `probeAvailability()` were the same function, the probe was taken once
   * at construction, and nothing anywhere could install or build the helper the
   * whole tier runs on.
   */
  async availability(): Promise<ComputerAvailability> {
    const refusal = this.platformRefusal();
    if (refusal) return refusal;
    const failure = await this.ensureProvisioned();
    const blockers = this.capabilityBlockers();
    if (blockers.length > 0) {
      // The provisioning failure wins when there is one: "this machine is
      // missing gcc" is actionable, where the plan's refusal can only say the
      // helper is absent without knowing why installing it did not work. It is
      // also error text this backend does not control — a compiler diagnostic,
      // a checksum mismatch — so it is clamped to the contract's message bound
      // rather than allowed to fail the state payload carrying it.
      return {
        kind: "backend-unavailable",
        message: clampComputerMessage(failure ?? blockers.join(" "), UNAVAILABLE_FALLBACK_MESSAGE),
      };
    }
    return { kind: "available", backend: "portal" };
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
    await this.adoptProbe();
    return result.summary;
  }

  private platformRefusal(): ComputerAvailability | undefined {
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
    return undefined;
  }

  /**
   * Perception and action are the floor: a desktop that can supply neither is
   * not a desktop Synara can drive, whatever else resolved. Windows and
   * clipboard missing is a degraded but usable backend — the agent works in
   * desktop coordinates — so it does not fail availability, only capability.
   */
  private capabilityBlockers(): readonly string[] {
    return [
      describeSlot("Input", this.providers.input),
      describeSlot("Screen capture", this.providers.capture),
    ].filter((message): message is string => message !== undefined);
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
      // the desktop can do, so the probe is retaken.
      if (result.action !== "already-current" || this.probe.helperBinary === undefined) {
        await this.adoptProbe();
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
   * Re-probe and, if the answer changed, swap in the provider set it implies.
   *
   * Serialized on `adoptChain`: two adoptions interleaving would each capture
   * the same previous provider set and dispose it twice while both fresh sets
   * survive. The real work is in `adoptProbeNow`.
   */
  private adoptProbe(): Promise<void> {
    const run = this.adoptChain.then(() => this.adoptProbeNow());
    this.adoptChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * The plan is compared rather than applied unconditionally, slot by slot. On
   * GNOME the live providers may be holding a portal session the user has
   * already consented to, and rebuilding an identical set would drop that
   * grant and put a second dialog on their screen for no gain — so a slot
   * whose choice is unchanged keeps its live provider and only the slots whose
   * answer actually changed take fresh ones.
   *
   * The one constraint on that grafting is that providers share resources in
   * families: the wlroots providers hold refcounted shares of one
   * compositor-attached helper process, the portal providers shares of one
   * consent-gated session. Splitting a family across old and new sets would
   * leave two helper processes attached to the compositor, or two portal
   * sessions each raising its own dialog — so a changed slot pulls every slot
   * sharing its resource family along with it. Discarding an unused fresh
   * provider is free: it was never opened, and releasing it only drops its
   * share of a resource that spawns lazily.
   */
  private async adoptProbeNow(): Promise<void> {
    if (this.disposed || !this.reprobe || !this.buildProviders) return;
    const probe = await this.reprobe();
    // Disposal may have happened while the probe was in flight, and a provider
    // set adopted now would never be disposed.
    if (this.disposed) return;
    const plan = planPortalProviders(probe);
    if (samePlan(plan, this.plan)) {
      this.probe = probe;
      return;
    }
    // Built before anything is assigned, so a construction failure leaves the
    // backend on its previous, internally consistent set.
    const fresh = this.buildProviders(probe);
    const previous = this.providers;
    const previousPlan = this.plan;
    const changedFamilies = new Set<ProviderResourceFamily>();
    for (const slot of PORTAL_CAPABILITY_SLOTS) {
      if (!slotResourceChanged(plan[slot], previousPlan[slot])) continue;
      // Both sides count: the family the slot is leaving loses a member, and
      // the family it is joining must not end up split across two resources.
      for (const choice of [previousPlan[slot], plan[slot]]) {
        const family = resourceFamily(choice.implementation);
        if (family !== undefined) changedFamilies.add(family);
      }
    }
    const discards: Array<() => Promise<void> | void> = [];
    const pick = <T extends { dispose(): Promise<void> }>(
      slot: PortalCapabilitySlot,
      previousSlot: ProviderSlot<T>,
      freshSlot: ProviderSlot<T>,
    ): ProviderSlot<T> => {
      const dragged = [previousPlan[slot].implementation, plan[slot].implementation].some(
        (implementation) => {
          const family = resourceFamily(implementation);
          return family !== undefined && changedFamilies.has(family);
        },
      );
      const keep =
        !dragged && !slotResourceChanged(plan[slot], previousPlan[slot]) && previousSlot.available;
      if (keep) {
        if (freshSlot.available) discards.push(() => freshSlot.provider.dispose());
        return previousSlot;
      }
      if (previousSlot.available) discards.push(() => previousSlot.provider.dispose());
      return freshSlot;
    };
    // The previous idle source belongs to whichever family produced it — the
    // helper-backed source wins in `pickSeatIdle`, so it is helper-backed
    // exactly when a helper-family provider was live. It survives only if that
    // family did; otherwise it would hold the last share of a resource every
    // other slot just left.
    const previousSeatIdleFamily: ProviderResourceFamily = PORTAL_CAPABILITY_SLOTS.some(
      (slot) =>
        resourceFamily(previousPlan[slot].implementation) === "helper" && previous[slot].available,
    )
      ? "helper"
      : "session";
    const keepSeatIdle =
      previous.seatIdle !== undefined && !changedFamilies.has(previousSeatIdleFamily);
    const seatIdle = keepSeatIdle ? previous.seatIdle : fresh.seatIdle;
    const discardedSeatIdle = keepSeatIdle ? fresh.seatIdle : previous.seatIdle;
    if (discardedSeatIdle !== undefined) discards.push(() => discardedSeatIdle.dispose());
    const next: PortalProviders = {
      input: pick("input", previous.input, fresh.input),
      capture: pick("capture", previous.capture, fresh.capture),
      windows: pick("windows", previous.windows, fresh.windows),
      clipboard: pick("clipboard", previous.clipboard, fresh.clipboard),
      ...(seatIdle !== undefined ? { seatIdle } : {}),
    };
    this.probe = probe;
    this.plan = plan;
    this.providers = next;
    const capabilities = capabilitiesFromProviders(next);
    const capabilitiesChanged = !sameComputerCapabilities(capabilities, this.capabilitySet);
    this.capabilitySet = capabilities;
    // The arbiter follows its idle source: an unchanged source keeps its
    // primed seat sample, a replaced one has to be re-primed against the new
    // resource.
    const wantArbiter = seatIdle !== undefined && capabilities.sharedSeat;
    if (!(wantArbiter && this.arbiter !== undefined && seatIdle === previous.seatIdle)) {
      this.arbiter =
        wantArbiter && seatIdle !== undefined
          ? new SharedSeatArbiter({ source: seatIdle, now: () => this.now() })
          : undefined;
      this.seatPrimed = false;
    }
    if (capabilitiesChanged) {
      this.emit({ type: "capabilities-changed", capabilities: this.capabilitySet });
    }
    // Health can move with the capture slot, and the panel reads it live.
    this.healthState.publish();
    await Promise.allSettled(discards.map((dispose) => Promise.resolve().then(dispose)));
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
    const provider = requireProvider(this.providers.windows, "Listing windows");
    return await provider.listWindows();
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
    const windows = await this.listWindows();
    const rect = await this.workspaceRect();
    const screenshot = options.includeScreenshot
      ? await this.captureRect(rect, this.captureMaxDimension)
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
    if (this.consent === "denied") return "unavailable";
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
    const from = this.currentPoint ?? (await input.pointerPosition?.()) ?? to;
    await glidePointerToDeadline({
      sink: input.sink,
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
    return alignRect(await provider.workspaceRect());
  }

  private async captureRect(
    region: ComputerRect,
    maxDimension: number,
  ): Promise<ComputerScreenshot> {
    const provider = requireProvider(this.providers.capture, "Capturing the screen");
    const workspace = alignRect(await provider.workspaceRect());
    const requested = alignRect(region);
    const clipped = intersectComputerRects(requested, workspace);
    if (!clipped) {
      throw new ComputerBackendError(
        `The requested capture region ${formatRect(requested)} lies outside the desktop ${formatRect(workspace)}.`,
      );
    }
    const captured = await provider.captureRegion(clipped, maxDimension);
    return screenshotFromPng({
      bytes: captured.bytes,
      region: captured.region,
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
      const screenshot = await this.captureRect(rect, this.captureMaxDimension);
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

/**
 * Whether two plans would resolve to the same providers.
 *
 * Compared on both the implementation and the refusal, because a slot that
 * moved from "blocked, no helper" to "blocked, no such protocol" is a different
 * answer to the user even though neither resolves a provider. This is the
 * adopt path's do-nothing fast path; when it fails, `slotResourceChanged`
 * decides per slot whether a live provider actually has to be replaced.
 */
function samePlan(left: PortalProviderPlan, right: PortalProviderPlan): boolean {
  return PORTAL_CAPABILITY_SLOTS.every(
    (slot) =>
      left[slot].implementation === right[slot].implementation &&
      left[slot].blockedBy === right[slot].blockedBy,
  );
}

/**
 * Whether a slot's choice changed in a way that changes which provider serves
 * it. The refusal text is deliberately not compared here: a blocked slot's
 * message changing is a reason to adopt the fresh `missingProvider` — which is
 * free — never a reason to tear down a live one.
 */
function slotResourceChanged(next: PortalProviderChoice, previous: PortalProviderChoice): boolean {
  return (
    next.implementation !== previous.implementation ||
    (next.blockedBy === undefined) !== (previous.blockedBy === undefined)
  );
}

type ProviderResourceFamily = "helper" | "session";

/**
 * Which long-lived resource an implementation's provider holds a share of.
 * Helper-family providers ride one compositor-attached helper process,
 * session-family providers one consent-gated portal session. Standalone
 * implementations — wl-clipboard, the GNOME Shell extension — own nothing
 * shared and graft independently.
 */
function resourceFamily(
  implementation: PortalProviderId | undefined,
): ProviderResourceFamily | undefined {
  switch (implementation) {
    case "wlroots-virtual-input":
    case "wlr-screencopy":
    case "wlr-foreign-toplevel":
      return "helper";
    case "portal-remote-desktop":
    case "portal-selection":
      return "session";
    default:
      return undefined;
  }
}

/** Field-wise equality, for deciding whether an adoption moved a capability. */
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
  // provider set built after provisioning is wired to consent exactly the way
  // the first one was.
  const build = (forProbe: PortalProbe): PortalProviders =>
    resolvePortalProviders(forProbe, {
      ...providerOptions,
      onConsentChanged: (state, reason) => {
        backend?.setConsentState(state, reason);
        providerOptions?.onConsentChanged?.(state, reason);
      },
      onSessionClosed: (reason) => {
        providerOptions?.onSessionClosed?.(reason);
      },
    });
  backend = new PortalComputerBackend({
    // Rebuilding is a pure function of the probe and this factory's own
    // provider options, so it is safe to default. Provisioning and re-probing
    // are not: this factory is handed a probe and has no way to know whether it
    // describes the machine it is running on or a desktop a caller made up, and
    // defaulting them would let a unit test install a helper on the developer's
    // laptop and then re-probe their real session. `ComputerService` is the one
    // place that knows the probe came from this host, so it supplies them.
    buildProviders: build,
    ...rest,
    probe,
    providers: providers ?? build(probe),
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
