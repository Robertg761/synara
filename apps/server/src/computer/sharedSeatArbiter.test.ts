import { describe, expect, it } from "vitest";

import { ComputerBackendError } from "./ComputerBackend.ts";
import { fakeDesktopHelper } from "./portal/fakeDesktopHelper.ts";
import type { DesktopHelperIdleState } from "./portal/desktopHelperClient.ts";
import {
  createDesktopHelperIdleSource,
  createMutterIdleSource,
  DEFAULT_HUMAN_ACTIVE_THRESHOLD_MS,
  HUMAN_ACTIVE_REFUSAL,
  SharedSeatArbiter,
  type SeatActivity,
  type SeatIdleSource,
} from "./sharedSeatArbiter.ts";

/** A clock the test moves by hand, so every timing assertion is exact. */
function fakeClock(start = 100_000) {
  let current = start;
  return {
    now: () => current,
    advance: (milliseconds: number) => {
      current += milliseconds;
    },
  };
}

/** A source whose answer, and whose call log, the test owns. */
function scriptedSource(answers: SeatActivity | (() => SeatActivity | Promise<SeatActivity>)) {
  const windows: number[] = [];
  const source: SeatIdleSource = {
    sample: async (windowMs) => {
      windows.push(windowMs);
      return typeof answers === "function" ? await answers() : answers;
    },
  };
  return { source, windows };
}

function arbiterFor(
  activity: SeatActivity | (() => SeatActivity | Promise<SeatActivity>),
  options: { readonly now?: () => number; readonly thresholdMs?: number } = {},
) {
  const scripted = scriptedSource(activity);
  return {
    ...scripted,
    arbiter: new SharedSeatArbiter({
      source: scripted.source,
      ...(options.now ? { now: options.now } : {}),
      ...(options.thresholdMs === undefined ? {} : { thresholdMs: options.thresholdMs }),
    }),
  };
}

describe("SharedSeatArbiter", () => {
  it("lets the agent act on a seat nobody has touched", async () => {
    const { arbiter, windows } = arbiterFor({ state: "quiet", idleMs: 30_000 });

    await expect(arbiter.guardMutation()).resolves.toBeUndefined();
    // The threshold is passed to the source rather than kept privately, which
    // is what stops a compositor-side window from drifting away from it.
    expect(windows).toEqual([DEFAULT_HUMAN_ACTIVE_THRESHOLD_MS]);
  });

  it("yields when the seat saw input the agent cannot account for", async () => {
    const clock = fakeClock();
    const { arbiter } = arbiterFor({ state: "active", datedInputMs: 300 }, { now: clock.now });

    await expect(arbiter.guardMutation()).rejects.toThrow(HUMAN_ACTIVE_REFUSAL);
  });

  it("marks a yield retryable, because the human will stop", async () => {
    const { arbiter } = arbiterFor({ state: "active", datedInputMs: 10 });

    // Non-retryable would end the turn on what is a pause by definition.
    const error = await arbiter.guardMutation().catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ComputerBackendError);
    expect((error as ComputerBackendError).retryable).toBe(true);
  });

  it("does not yield to the agent's own input", async () => {
    // The whole point of attribution: synthetic events reset the same idle
    // clock a human's do, so without this the agent locks itself out after its
    // own first click.
    const clock = fakeClock();
    const { arbiter } = arbiterFor({ state: "active", datedInputMs: 400 }, { now: clock.now });

    arbiter.noteAgentAction();
    clock.advance(400);

    await expect(arbiter.guardMutation()).resolves.toBeUndefined();
  });

  it("yields to input that arrived after the agent's last action", async () => {
    const clock = fakeClock();
    const { arbiter } = arbiterFor({ state: "active", datedInputMs: 200 }, { now: clock.now });

    arbiter.noteAgentAction();
    // The agent acted 2 s ago; the burst on the seat started 200 ms ago, which
    // is nobody's but the human's.
    clock.advance(2_000);

    await expect(arbiter.guardMutation()).rejects.toThrow(HUMAN_ACTIVE_REFUSAL);
  });

  it("yields to a human who arrived before the agent ever acted", async () => {
    const { arbiter } = arbiterFor({ state: "active", datedInputMs: 900 });

    await expect(arbiter.guardMutation()).rejects.toThrow(HUMAN_ACTIVE_REFUSAL);
  });

  it("treats input inside the attribution epsilon as the agent's echo", async () => {
    const clock = fakeClock();
    const scripted = scriptedSource({ state: "active", datedInputMs: 0 });
    const arbiter = new SharedSeatArbiter({
      source: scripted.source,
      now: clock.now,
      attributionEpsilonMs: 250,
    });

    arbiter.noteAgentAction();
    clock.advance(250);

    // Exactly at the boundary the input is still the agent's: the compositor
    // accounts for a synthetic event some unmeasurable moment after it is sent.
    await expect(arbiter.guardMutation()).resolves.toBeUndefined();
  });

  it("yields one millisecond past the attribution epsilon", async () => {
    const clock = fakeClock();
    const scripted = scriptedSource({ state: "active", datedInputMs: 0 });
    const arbiter = new SharedSeatArbiter({
      source: scripted.source,
      now: clock.now,
      attributionEpsilonMs: 250,
    });

    arbiter.noteAgentAction();
    clock.advance(251);

    await expect(arbiter.guardMutation()).rejects.toThrow(HUMAN_ACTIVE_REFUSAL);
  });

  it("yields to a human who stopped inside the threshold, quiet though the seat is", async () => {
    // "Quiet" is not "clear". A human who paused 600 ms ago is still sitting
    // there, and the threshold — not the compositor's idea of idle — decides.
    const { arbiter } = arbiterFor({ state: "quiet", idleMs: 600 });

    await expect(arbiter.guardMutation()).rejects.toThrow(HUMAN_ACTIVE_REFUSAL);
  });

  it("does not yield to a quiet seat the agent itself just stopped driving", async () => {
    const clock = fakeClock();
    const { arbiter } = arbiterFor({ state: "quiet", idleMs: 600 }, { now: clock.now });

    arbiter.noteAgentAction();
    clock.advance(600);

    await expect(arbiter.guardMutation()).resolves.toBeUndefined();
  });

  it("yields while the compositor has said nothing, rather than reading silence as an empty desk", async () => {
    // A notification that has never fired looks the same whether the desk is
    // empty or the human has not paused once since it was armed.
    const { arbiter } = arbiterFor({ state: "unknown", reason: "nothing yet" });

    await expect(arbiter.guardMutation()).rejects.toThrow(/nothing yet/);
  });

  it("yields on silence even right after the agent acted", async () => {
    // Attribution needs a dated event to work on. Silence has none, so the
    // agent's own recent action buys nothing here.
    const clock = fakeClock();
    const { arbiter } = arbiterFor({ state: "unknown", reason: "nothing yet" }, { now: clock.now });

    arbiter.noteAgentAction();

    await expect(arbiter.guardMutation()).rejects.toThrow(HUMAN_ACTIVE_REFUSAL);
  });

  it("records when it last gave way, for the panel to say so", async () => {
    const clock = fakeClock();
    const { arbiter } = arbiterFor({ state: "active", datedInputMs: 100 }, { now: clock.now });

    expect(arbiter.status().lastYieldAt).toBeUndefined();
    await arbiter.guardMutation().catch(() => undefined);

    expect(arbiter.status()).toMatchObject({
      observing: true,
      lastYieldAt: clock.now(),
    });
  });

  it("stands down for good on a desktop that can never answer", async () => {
    let samples = 0;
    const arbiter = new SharedSeatArbiter({
      source: {
        sample: async () => {
          samples += 1;
          throw new ComputerBackendError(
            "this compositor does not advertise ext_idle_notifier_v1",
            {
              retryable: false,
            },
          );
        },
      },
    });

    await expect(arbiter.guardMutation()).resolves.toBeUndefined();
    await expect(arbiter.guardMutation()).resolves.toBeUndefined();

    // Asked once, never again: the answer cannot change, and buying it before
    // every click would be a round trip per action for a fixed refusal.
    expect(samples).toBe(1);
    expect(arbiter.status()).toMatchObject({
      observing: false,
      reason: expect.stringContaining("ext_idle_notifier_v1"),
    });
  });

  it("keeps asking after a failure that might pass", async () => {
    let samples = 0;
    const arbiter = new SharedSeatArbiter({
      source: {
        sample: async () => {
          samples += 1;
          throw new ComputerBackendError("the desktop helper exited (signal SIGKILL)", {
            retryable: true,
          });
        },
      },
    });

    await expect(arbiter.guardMutation()).resolves.toBeUndefined();
    await expect(arbiter.guardMutation()).resolves.toBeUndefined();

    expect(samples).toBe(2);
    // Fails open: yielding is a courtesy the user consented past, and a broken
    // idle source must not take desktop control down with it.
    expect(arbiter.status()).toMatchObject({
      observing: true,
      reason: expect.stringContaining("SIGKILL"),
    });
  });

  it("clears a stale failure once the source answers again", async () => {
    let fail = true;
    const arbiter = new SharedSeatArbiter({
      source: {
        sample: async () => {
          if (fail) throw new ComputerBackendError("a hiccup", { retryable: true });
          return { state: "quiet", idleMs: 30_000 };
        },
      },
    });

    await arbiter.guardMutation();
    fail = false;
    await arbiter.guardMutation();

    expect(arbiter.status().reason).toBeUndefined();
  });

  it("notes the action after the body runs, so a long drag counts from its end", async () => {
    const clock = fakeClock();
    let activity: SeatActivity = { state: "quiet", idleMs: 30_000 };
    const arbiter = new SharedSeatArbiter({
      source: { sample: async () => activity },
      now: clock.now,
    });

    await arbiter.guarded(async () => {
      clock.advance(3_000);
    });

    // The seat's burst started when the drag did, 3.1 s ago; the agent's last
    // event was at the drag's end, and only noting *after* the body keeps this
    // from reading as a human who joined mid-drag.
    clock.advance(100);
    activity = { state: "active", datedInputMs: 3_100 };
    await expect(arbiter.guardMutation()).resolves.toBeUndefined();
  });

  it("notes an action that failed part-way, because its input still landed", async () => {
    const clock = fakeClock();
    let activity: SeatActivity = { state: "quiet", idleMs: 30_000 };
    const arbiter = new SharedSeatArbiter({
      source: { sample: async () => activity },
      now: clock.now,
    });

    await expect(
      arbiter.guarded(async () => {
        throw new Error("the chord broke after ctrl went down");
      }),
    ).rejects.toThrow(/chord broke/);

    // Half a chord is still keys the compositor saw, and unaccounted events are
    // exactly what the next guard would refuse on.
    clock.advance(100);
    activity = { state: "active", datedInputMs: 100 };
    await expect(arbiter.guardMutation()).resolves.toBeUndefined();
  });

  it("does not credit the agent for an action it was refused", async () => {
    const clock = fakeClock();
    const { arbiter } = arbiterFor({ state: "active", datedInputMs: 100 }, { now: clock.now });

    await expect(arbiter.guarded(async () => "unreachable")).rejects.toThrow(HUMAN_ACTIVE_REFUSAL);
    // Still refusing: a blocked action drove nothing, so it cannot be the
    // explanation for what is on the seat.
    await expect(arbiter.guardMutation()).rejects.toThrow(HUMAN_ACTIVE_REFUSAL);
  });

  it("keeps the newest agent action when one is noted out of order", async () => {
    const clock = fakeClock();
    const { arbiter } = arbiterFor({ state: "active", datedInputMs: 0 }, { now: clock.now });

    arbiter.noteAgentAction(clock.now());
    arbiter.noteAgentAction(clock.now() - 5_000);

    await expect(arbiter.guardMutation()).resolves.toBeUndefined();
  });

  it("arms the source during startup rather than on the first click", async () => {
    let samples = 0;
    const arbiter = new SharedSeatArbiter({
      source: {
        sample: async () => {
          samples += 1;
          return { state: "quiet", idleMs: 30_000 };
        },
      },
    });

    arbiter.prime();
    await Promise.resolve();

    expect(samples).toBe(1);
  });

  it("swallows a priming failure instead of rejecting where nobody is waiting", async () => {
    const arbiter = new SharedSeatArbiter({
      source: {
        sample: () => Promise.reject(new ComputerBackendError("no helper", { retryable: false })),
      },
    });

    arbiter.prime();
    await Promise.resolve();
    await Promise.resolve();

    expect(arbiter.status()).toMatchObject({ observing: false });
  });
});

describe("createDesktopHelperIdleSource", () => {
  function helperWith(idleState: DesktopHelperIdleState) {
    const helper = fakeDesktopHelper({ idleState });
    return { helper, source: createDesktopHelperIdleSource(helper) };
  }

  it("arms a window shorter than the threshold, and the same one every time", async () => {
    const { helper, source } = helperWith({
      idle: true,
      sinceMs: 0,
      timeoutMs: 500,
      observed: true,
    });

    await source.sample(2_000);
    await source.sample(2_000);

    // One window for the notification's whole life: a changed timeout is a
    // re-armed notification, which throws away everything it had established.
    expect(helper.calls).toEqual(["idleState 500", "idleState 500"]);
  });

  it("never arms outside what the helper accepts", async () => {
    const { helper, source } = helperWith({
      idle: true,
      sinceMs: 0,
      timeoutMs: 100,
      observed: true,
    });

    // A threshold below the helper's floor would be an invalid-params refusal
    // instead of an answer, so it clamps rather than asking.
    await source.sample(20);

    expect(helper.calls).toEqual(["idleState 100"]);
  });

  it("turns an idle notification into the duration the threshold is applied to", async () => {
    const { source } = helperWith({
      idle: true,
      sinceMs: 900,
      timeoutMs: 500,
      observed: true,
    });

    // The seat had been quiet for the armed window when the compositor said so,
    // and for `sinceMs` more since.
    await expect(source.sample(2_000)).resolves.toEqual({
      state: "quiet",
      idleMs: 1_400,
    });
  });

  it("dates a busy seat by the start of its burst, which is all the protocol gives", async () => {
    const { source } = helperWith({
      idle: false,
      sinceMs: 340,
      timeoutMs: 500,
      observed: true,
    });

    await expect(source.sample(2_000)).resolves.toEqual({
      state: "active",
      datedInputMs: 340,
    });
  });

  it("reports an unspoken notification as unknown, not as a quiet seat", async () => {
    const { source } = helperWith({
      idle: false,
      sinceMs: 120,
      timeoutMs: 500,
      observed: false,
    });

    await expect(source.sample(2_000)).resolves.toMatchObject({
      state: "unknown",
    });
  });

  it("refuses a mutation while the notification is still settling", async () => {
    const helper = fakeDesktopHelper({
      idleState: { idle: false, sinceMs: 12, timeoutMs: 500, observed: false },
    });
    const arbiter = new SharedSeatArbiter({
      source: createDesktopHelperIdleSource(helper),
    });

    await expect(arbiter.guardMutation()).rejects.toThrow(HUMAN_ACTIVE_REFUSAL);
  });

  it("lets the agent act against the quiet seat the fake helper describes", async () => {
    const arbiter = new SharedSeatArbiter({
      source: createDesktopHelperIdleSource(fakeDesktopHelper()),
    });

    await expect(arbiter.guardMutation()).resolves.toBeUndefined();
  });

  it("stands the arbiter down when the compositor has no idle protocol", async () => {
    const helper = fakeDesktopHelper({
      failWith: "this compositor does not advertise it",
    });
    const arbiter = new SharedSeatArbiter({
      source: createDesktopHelperIdleSource(helper),
    });

    await expect(arbiter.guardMutation()).resolves.toBeUndefined();
    expect(arbiter.status().observing).toBe(false);
  });
});

describe("createMutterIdleSource", () => {
  it("reads GetIdletime as an exact quiet duration", async () => {
    const source = createMutterIdleSource({
      readIdletimeMs: () => Promise.resolve(4_231),
    });

    // No burst, no blind window: mutter dates the last input itself, which is
    // why GNOME's yield is sharper than wlroots'.
    await expect(source.sample(2_000)).resolves.toEqual({
      state: "quiet",
      idleMs: 4_231,
    });
  });

  it("yields on a freshly touched seat", async () => {
    const arbiter = new SharedSeatArbiter({
      source: createMutterIdleSource({
        readIdletimeMs: () => Promise.resolve(120),
      }),
    });

    await expect(arbiter.guardMutation()).rejects.toThrow(HUMAN_ACTIVE_REFUSAL);
  });

  it("does not yield to the agent's own input, dated exactly", async () => {
    const clock = fakeClock();
    const arbiter = new SharedSeatArbiter({
      source: createMutterIdleSource({
        readIdletimeMs: () => Promise.resolve(40),
      }),
      now: clock.now,
    });

    arbiter.noteAgentAction();
    clock.advance(40);

    await expect(arbiter.guardMutation()).resolves.toBeUndefined();
  });

  it("never reports a negative idle time, whatever the bus says", async () => {
    // A clock that has gone backwards would otherwise date input in the future,
    // which reads as the agent's own and hands the seat away.
    const source = createMutterIdleSource({
      readIdletimeMs: () => Promise.resolve(-50),
    });

    await expect(source.sample(2_000)).resolves.toEqual({
      state: "quiet",
      idleMs: 0,
    });
  });
});
