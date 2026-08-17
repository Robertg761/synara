/**
 * Yield to the human.
 *
 * Tier 1 gave the agent a seat of its own, so the question never arose. Tier 2
 * has no second seat to give: libei attaches to the session the human is using,
 * and wlroots' virtual devices attach to the same `wl_seat` their keyboard is
 * on. The real cursor moves, real focus follows, and two participants are
 * driving one desk. This module is the traffic rule between them — the agent
 * gives way while the human is touching the seat, and takes it back once they
 * stop.
 *
 * The rule is deliberately one-sided. Only *mutating* actions yield: input,
 * clipboard writes, window activation. Perception — capture, window lists,
 * clipboard reads, screen size — never yields, because looking at a screen the
 * human is using disturbs nobody and an agent that cannot see while its user
 * works is an agent that has to start its turn over.
 *
 * ## What can actually be observed
 *
 * Neither idle source reports "the *human* did something". Both report "the
 * seat saw input", and the agent's own synthetic input is seat input: it resets
 * the idle clock exactly as a real keystroke does. Without attribution the
 * agent's first click would look like a human arriving, and the agent would
 * lock itself out for the rest of the turn.
 *
 * So attribution is this module's real job, and it is done with a timestamp:
 * every synthetic action is noted, and seat input is the human's only when it
 * can be dated later than the agent's own last action. `guardMutation` samples
 * *before* the agent acts, for the same reason — sampling afterwards would read
 * back the agent's own footprints.
 *
 * ## The ambiguity window, stated plainly
 *
 * There is a window in which a human keystroke is indistinguishable from the
 * agent's own, and it is not small:
 *
 * - `attributionEpsilonMs` after each synthetic event, everywhere. Input this
 *   close to the agent's own is assumed to be the agent's, because the delay
 *   between issuing a synthetic event and the compositor accounting for it is
 *   unmeasurable from here.
 * - On wlroots, until the seat next goes quiet. `ext_idle_notify_v1` reports
 *   transitions, not events, so the only datable moment inside a burst of
 *   activity is when the burst *started*. If the agent starts a burst and the
 *   human joins it before it ends, the human is inside the agent's shadow until
 *   the seat has been quiet for the notification's window (see
 *   `DEFAULT_IDLE_ARM_MS`, half a second).
 * - On GNOME there is no burst shadow: `GetIdletime` dates the most recent
 *   input exactly, so the window is `attributionEpsilonMs` and nothing more.
 *
 * This is a courtesy, not a safety boundary. The boundary is the user's own
 * opt-in to shared control and the pane's stop button; the arbiter exists so
 * that opt-in does not mean fighting over the mouse. When it cannot observe the
 * seat at all it says so and gets out of the way rather than bricking every
 * mutating action — but "I have not been told yet" is never read as "nobody is
 * there", because that is the reading that types into a human's window.
 */
import { createRequire } from "node:module";
import type { EventEmitter } from "node:events";

import type dbusModule from "dbus-next";

import { ComputerBackendError } from "./ComputerBackend.ts";
import { invokeKWinDbusMethod } from "./kwinDbus.ts";
import {
  DESKTOP_HELPER_IDLE_TIMEOUT_MS,
  type DesktopHelperTransport,
} from "./portal/desktopHelperClient.ts";

/**
 * The token every yield refusal carries.
 *
 * One string across both desktops and both refusal reasons, because the caller
 * that matters — the tool surface, and the panel copy that tells the user why
 * the agent stopped — treats them identically: wait, then try again.
 */
export const HUMAN_ACTIVE_REFUSAL = "computer_human_active";

/** How recently the seat must have seen a human for the agent to give way. */
export const DEFAULT_HUMAN_ACTIVE_THRESHOLD_MS = 2_000;

/**
 * How close to the agent's own last action seat input is still assumed to be
 * the agent's.
 *
 * It covers the unmeasurable gap between issuing a synthetic event and the
 * compositor accounting for it — a portal round trip on GNOME, a Wayland flush
 * on wlroots — plus the clock skew between this process and the compositor's
 * own idea of when input arrived. Too small and the agent yields to itself
 * after every click; too large and a human who reaches in immediately after an
 * agent action is written off as an echo.
 */
export const DEFAULT_ATTRIBUTION_EPSILON_MS = 250;

/**
 * The window the wlroots idle notification is armed at, which is not the yield
 * threshold and deliberately shorter than it.
 *
 * The notification's timeout does three things at once: it is how long the
 * source is blind after arming, how long a burst of activity keeps merging
 * (and hiding a human inside the agent's shadow), and the granularity of the
 * "quiet" duration. All three want it short. What wants it long is nothing —
 * the yield threshold is applied by the arbiter against the duration this
 * produces, so a short window costs only compositor timer wakeups on a desktop
 * that is already transitioning between busy and quiet.
 */
export const DEFAULT_IDLE_ARM_MS = 500;

/**
 * What an idle source can honestly say about a shared seat.
 *
 * Three states rather than a duration, because the two desktops can say
 * genuinely different things and flattening them loses the part that decides
 * the outcome:
 *
 * - `quiet` — the seat saw no input at all for `idleMs`. A promise about a
 *   span of time, so the yield threshold applies to it directly.
 * - `active` — the seat has seen input more recently than `quiet` would allow,
 *   and `datedInputMs` ago is the most recent moment the source can *date* one.
 *   On GNOME that is the last event; on wlroots it is the start of the current
 *   burst, which may be long before the last event inside it.
 * - `unknown` — the source is working and has nothing to report yet. It is not
 *   `quiet` with a small number and it is not `active`: a compositor that has
 *   never sent a transition looks exactly the same whether the desk is empty or
 *   the human has not stopped typing since the helper started.
 */
export type SeatActivity =
  | { readonly state: "quiet"; readonly idleMs: number }
  | { readonly state: "active"; readonly datedInputMs: number }
  | { readonly state: "unknown"; readonly reason: string };

export interface SeatIdleSource {
  /**
   * The seat's activity, as of now.
   *
   * `windowMs` is the arbiter's yield threshold, passed on every call so the
   * two can never drift apart: a source that arms a compositor-side timer sizes
   * it from this rather than from a constant of its own. A source is free to
   * observe a *shorter* window — `quiet` carries its duration, so a finer
   * reading than the threshold is still answerable.
   *
   * Rejecting is allowed and meaningful. A non-retryable `ComputerBackendError`
   * means this desktop can never answer, and the arbiter stands down for good
   * rather than paying a round trip per action forever.
   */
  sample(windowMs: number): Promise<SeatActivity>;
}

export interface SharedSeatArbiterOptions {
  readonly source: SeatIdleSource;
  readonly thresholdMs?: number;
  readonly attributionEpsilonMs?: number;
  /**
   * The backend's clock, shared so tests drive both from one place. `Date.now`
   * by default; a wall-clock step between noting an action and sampling can
   * misattribute one action, which is a fair price for matching the clock every
   * other part of the backend is tested against.
   */
  readonly now?: () => number;
}

export interface SharedSeatArbiterStatus {
  /** Whether the human can be observed at all. False latches, with a reason. */
  readonly observing: boolean;
  /** Why observation stopped, or why the last sample was unusable. */
  readonly reason?: string;
  /** When the agent last gave way, for the panel's "waiting for you" copy. */
  readonly lastYieldAt?: number;
}

export class SharedSeatArbiter {
  private readonly source: SeatIdleSource;
  private readonly thresholdMs: number;
  private readonly epsilonMs: number;
  private readonly now: () => number;
  /**
   * `-Infinity` rather than the construction time, so that an agent that has
   * never acted attributes everything to the human. Starting the clock at
   * construction would give the agent a free pass over any activity older than
   * the backend, which on a long-lived server is all of it.
   */
  private lastAgentActionAt = Number.NEGATIVE_INFINITY;
  private stoodDown: string | null = null;
  private lastSampleFailure: string | undefined;
  private lastYieldAt: number | undefined;

  constructor(options: SharedSeatArbiterOptions) {
    this.source = options.source;
    this.thresholdMs = options.thresholdMs ?? DEFAULT_HUMAN_ACTIVE_THRESHOLD_MS;
    this.epsilonMs = options.attributionEpsilonMs ?? DEFAULT_ATTRIBUTION_EPSILON_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Throws a retryable refusal when the seat belongs to the human right now.
   *
   * Called before the action, never after: the agent's own input is seat
   * activity, so a sample taken afterwards reads back its own footprints.
   */
  async guardMutation(): Promise<void> {
    if (this.stoodDown !== null) return;

    let activity: SeatActivity;
    try {
      activity = await this.source.sample(this.thresholdMs);
    } catch (error) {
      this.recordSampleFailure(error);
      // Fails open, deliberately. Yielding is a courtesy the user already
      // consented past; a broken idle source must not take desktop control down
      // with it, and the action that follows will fail on its own if the
      // desktop is genuinely gone.
      return;
    }
    this.lastSampleFailure = undefined;

    if (activity.state === "unknown") {
      this.yieldSeat(
        `the compositor has not reported the shared seat's idle state yet (${activity.reason}), and an unanswered seat is not an empty one`,
      );
    }
    // A duration the source is sure of, long enough to clear the threshold, is
    // the only answer that needs no attribution: nothing touched the seat,
    // agent or human.
    if (activity.state === "quiet" && activity.idleMs >= this.thresholdMs) return;

    const datedInputMs =
      activity.state === "quiet" ? activity.idleMs : Math.max(0, activity.datedInputMs);
    const inputAt = this.now() - datedInputMs;
    if (inputAt <= this.lastAgentActionAt + this.epsilonMs) return;

    this.yieldSeat(
      `the seat saw input ${formatSeconds(datedInputMs)} ago that the agent did not send`,
    );
  }

  /**
   * Records that the agent drove the seat, which is what keeps its own input
   * from reading as a human's on the next guard.
   *
   * Call it after every burst of synthetic input, including one that failed
   * part-way: a half-delivered chord still reached the compositor, and events
   * the agent cannot account for are exactly what this module refuses on.
   */
  noteAgentAction(at: number = this.now()): void {
    if (at > this.lastAgentActionAt) this.lastAgentActionAt = at;
  }

  /** Guard, act, and note — the shape every mutating call site wants. */
  async guarded<T>(run: () => Promise<T>): Promise<T> {
    await this.guardMutation();
    try {
      return await run();
    } finally {
      this.noteAgentAction();
    }
  }

  /**
   * Arms the source ahead of the first action.
   *
   * A compositor-side notification is blind for its whole window after arming,
   * and the arbiter refuses while blind. Paying that during startup, where a
   * second costs nothing, keeps it off the agent's first click. Failures are
   * the guard's business, not the caller's, so this never rejects.
   */
  prime(): void {
    if (this.stoodDown !== null) return;
    void this.source.sample(this.thresholdMs).then(
      () => undefined,
      (error: unknown) => this.recordSampleFailure(error),
    );
  }

  status(): SharedSeatArbiterStatus {
    const reason = this.stoodDown ?? this.lastSampleFailure;
    return {
      observing: this.stoodDown === null,
      ...(reason === undefined ? {} : { reason }),
      ...(this.lastYieldAt === undefined ? {} : { lastYieldAt: this.lastYieldAt }),
    };
  }

  private yieldSeat(detail: string): never {
    this.lastYieldAt = this.now();
    throw new ComputerBackendError(
      `${HUMAN_ACTIVE_REFUSAL}: ${detail}. This desktop has one seat, shared with you, so the ` +
        `agent waits rather than typing into whatever you are using. Looking at the screen, ` +
        `listing windows, and reading the clipboard still work; the action can be retried once ` +
        `the seat has been quiet for ${formatSeconds(this.thresholdMs)}.`,
      { retryable: true },
    );
  }

  private recordSampleFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    // A desktop with no idle protocol answers the same way every time, so the
    // arbiter stands down permanently instead of buying that answer again
    // before every click. Anything that might pass is retried.
    if (error instanceof ComputerBackendError && !error.retryable) {
      this.stoodDown = message;
      return;
    }
    this.lastSampleFailure = message;
  }
}

/**
 * The wlroots source: `ext_idle_notify_v1` through the desktop helper.
 *
 * The protocol has no request that asks how long the seat has been quiet, only
 * events when it crosses between quiet and busy, which is why this translation
 * exists at all. Each of the helper's three fields lands in a different part of
 * the answer: `observed` decides whether there is an answer, `idle` decides
 * which kind, and the armed timeout turns `idle` into the duration the
 * threshold is applied to.
 */
export function createDesktopHelperIdleSource(
  transport: Pick<DesktopHelperTransport, "idleState">,
  options: { readonly armMs?: number } = {},
): SeatIdleSource {
  return {
    sample: async (windowMs) => {
      // Never wider than the threshold — a window the agent does not care about
      // would blind the source for longer than the answer is worth — and never
      // outside what the helper accepts, which would be an invalid-params
      // refusal instead of an answer.
      const armMs = Math.min(
        Math.max(
          Math.min(options.armMs ?? DEFAULT_IDLE_ARM_MS, windowMs),
          DESKTOP_HELPER_IDLE_TIMEOUT_MS.min,
        ),
        DESKTOP_HELPER_IDLE_TIMEOUT_MS.max,
      );
      const state = await transport.idleState(armMs);
      if (!state.observed) {
        return {
          state: "unknown",
          reason: `ext_idle_notify_v1 has sent no transition in the ${state.sinceMs} ms since its ${state.timeoutMs} ms notification was armed`,
        };
      }
      if (state.idle) {
        // A lower bound, not a reading: the seat had been quiet for the armed
        // window when the compositor said so, and for `sinceMs` more since. How
        // much longer it had already been quiet before the notification existed
        // is not knowable, and guessing high is the direction that lets the
        // agent act over someone.
        return { state: "quiet", idleMs: state.timeoutMs + state.sinceMs };
      }
      return { state: "active", datedInputMs: state.sinceMs };
    },
  };
}

/** How long `close` waits for the D-Bus handshake before disconnecting anyway. */
const BUS_SETTLE_DEADLINE_MS = 10_000;

/** Where mutter keeps the session's idle clock. */
const MUTTER_IDLE_MONITOR = {
  busName: "org.gnome.Mutter.IdleMonitor",
  objectPath: "/org/gnome/Mutter/IdleMonitor/Core",
  interfaceName: "org.gnome.Mutter.IdleMonitor",
  method: "GetIdletime",
} as const;

/**
 * The GNOME source: `org.gnome.Mutter.IdleMonitor.GetIdletime`.
 *
 * Strictly better than the wlroots one and simpler for it. GetIdletime is a
 * direct reading of milliseconds since the last input event, so every answer is
 * `quiet` with an exact duration — there is no blind window after startup, no
 * burst to hide a human inside, and the yield threshold applies to the number
 * as given.
 */
export function createMutterIdleSource(
  options: { readonly readIdletimeMs?: () => Promise<number> } = {},
): SeatIdleSource & { close(): void } {
  // `close` is on the source because the reader below holds a session-bus
  // connection for the life of the backend, and a backend that is disposed
  // while the process keeps running must not leave it attached.
  const reader = options.readIdletimeMs
    ? { read: options.readIdletimeMs, close: () => undefined }
    : mutterIdletimeReader();
  return {
    sample: async () => ({ state: "quiet", idleMs: Math.max(0, await reader.read()) }),
    close: () => reader.close(),
  };
}

/**
 * One held session-bus connection, reconnected after any failure.
 *
 * Held rather than per-call, unlike the probe's throwaway connections in
 * `sessionBusNames.ts`: this runs before every mutating action for the life of
 * a live backend, and a connect/disconnect cycle per click would churn the bus
 * far harder than one idle connection costs it.
 */
function mutterIdletimeReader(): {
  readonly read: () => Promise<number>;
  readonly close: () => void;
} {
  let connection: MutterIdleConnection | null = null;
  return {
    read: async () => {
      connection ??= connectMutterIdleMonitor();
      try {
        return readIdleMilliseconds(await connection.read());
      } catch (error) {
        connection.close();
        connection = null;
        throw asIdleSourceError(error);
      }
    },
    close: () => {
      connection?.close();
      connection = null;
    },
  };
}

interface MutterIdleConnection {
  readonly read: () => Promise<unknown>;
  readonly close: () => void;
}

function connectMutterIdleMonitor(): MutterIdleConnection {
  // Keeps the optional Linux runtime out of test imports; this resolves only on
  // the production path, behind the backend's platform gate.
  const require = createRequire(import.meta.url);
  const dbus = require("dbus-next") as typeof dbusModule;
  const bus = dbus.sessionBus();
  const eventBus = bus as unknown as EventEmitter;
  let failure: unknown;
  // Resolves once the socket has either finished its handshake or given up, so
  // `close` never ends a stream dbus-next is still authenticating over.
  let markSettled: (() => void) | undefined;
  const settled = new Promise<void>((resolve) => {
    markSettled = resolve;
  });
  // Load-bearing, exactly as in `sessionBusNames.ts`: dbus-next emits
  // connection failures on the bus object, and an unhandled `error` event takes
  // the whole server down.
  const onFailure = (error: unknown) => {
    failure ??= error ?? new Error("the session bus disconnected");
    markSettled?.();
  };
  eventBus.on("error", onFailure);
  eventBus.on("disconnect", onFailure);
  // Started through `then` so that a synchronous throw out of `getProxyObject`
  // becomes this promise's rejection rather than an exception that escapes with
  // the bus connected and the listeners attached.
  const iface = Promise.resolve()
    .then(() => bus.getProxyObject(MUTTER_IDLE_MONITOR.busName, MUTTER_IDLE_MONITOR.objectPath))
    .then((object) => object.getInterface(MUTTER_IDLE_MONITOR.interfaceName));
  // The rejection is delivered to whichever `read` awaits it; without this it
  // is also an unhandled rejection in the meantime.
  iface.then(
    () => markSettled?.(),
    () => markSettled?.(),
  );
  return {
    read: async () => {
      if (failure !== undefined) throw failure;
      return await invokeKWinDbusMethod(await iface, MUTTER_IDLE_MONITOR.method);
    },
    close: () => {
      // Deferred rather than immediate: disconnecting mid-handshake ends the
      // socket under dbus-next, which then writes its auth line to it from a
      // `connect` listener — an uncaught exception, not a rejection, and it
      // would take the server down. A backend disposed within a few
      // milliseconds of construction hits exactly that window. The deadline
      // covers a handshake that never settles at all, which would otherwise
      // hold the connection open forever.
      const deadline = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, BUS_SETTLE_DEADLINE_MS);
        timer.unref?.();
      });
      void Promise.race([settled, deadline]).then(() => {
        bus.disconnect();
        eventBus.off("disconnect", onFailure);
        // The `error` listener stays attached: a late failure on the dying
        // socket must land on a listener, or the emitter throws it into the
        // process. The bus object is unreachable after this, so nothing leaks.
      });
    },
  };
}

/** `t` on the wire, which dbus-next hands over as a BigInt. */
function readIdleMilliseconds(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new ComputerBackendError(
    `${MUTTER_IDLE_MONITOR.busName} answered ${MUTTER_IDLE_MONITOR.method} with something that is not a millisecond count, so the human's idle time is unreadable.`,
    { retryable: true },
  );
}

/**
 * A desktop with no idle monitor on the bus is a permanent answer and stands
 * the arbiter down; everything else is worth asking again.
 */
function asIdleSourceError(error: unknown): ComputerBackendError {
  if (error instanceof ComputerBackendError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const missing = /ServiceUnknown|was not provided by any \.service files/i.test(message);
  return new ComputerBackendError(
    missing
      ? `Nothing owns ${MUTTER_IDLE_MONITOR.busName} on the session bus, so this desktop cannot report whether the human is at the keyboard (${message}).`
      : `${MUTTER_IDLE_MONITOR.busName} did not answer ${MUTTER_IDLE_MONITOR.method}: ${message}.`,
    { retryable: !missing, cause: error },
  );
}

function formatSeconds(milliseconds: number): string {
  return `${(Math.max(0, milliseconds) / 1000).toFixed(1)} s`;
}
