import type { OrchestrationEvent } from "@synara/contracts";
import { Effect, PubSub, Stream } from "effect";
import { describe, expect, it } from "vitest";

import {
  makeCursorSafeSnapshotLiveStream,
  ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT,
} from "./wsSnapshotLiveStream";

const event = (sequence: number) => ({ sequence }) as OrchestrationEvent;

describe("makeCursorSafeSnapshotLiveStream", () => {
  it("attaches before snapshot IO and deduplicates events covered by durable replay", async () => {
    const steps: string[] = [];
    const items = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* PubSub.unbounded<OrchestrationEvent>();
          const replayed = event(2);
          return yield* makeCursorSafeSnapshotLiveStream({
            subscribeLive: PubSub.subscribe(live).pipe(
              Effect.tap(() => Effect.sync(() => steps.push("attached"))),
              Effect.map((subscription) => Stream.fromEffectRepeat(PubSub.take(subscription))),
            ),
            snapshot: PubSub.publish(live, replayed).pipe(
              Effect.tap(() => Effect.sync(() => steps.push("snapshot"))),
              Effect.as({ snapshotSequence: 1 }),
            ),
            snapshotSequence: (snapshot) => snapshot.snapshotSequence,
            getHighWaterSequence: Effect.succeed(2),
            replay: () => Stream.succeed(replayed),
          }).pipe(Stream.take(2), Stream.runCollect);
        }),
      ),
    );

    expect(steps).toEqual(["attached", "snapshot"]);
    expect(Array.from(items)).toEqual([
      { kind: "snapshot", snapshot: { snapshotSequence: 1 } },
      { kind: "event", event: event(2) },
    ]);
  });

  it("emits the snapshot first, the fenced replay next, and newer live events last", async () => {
    const items = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* PubSub.unbounded<OrchestrationEvent>();
          const replayed = event(2);
          const newerLive = event(3);
          return yield* makeCursorSafeSnapshotLiveStream({
            subscribeLive: PubSub.subscribe(live).pipe(
              Effect.map((subscription) => Stream.fromEffectRepeat(PubSub.take(subscription))),
            ),
            snapshot: PubSub.publish(live, replayed).pipe(Effect.as({ snapshotSequence: 1 })),
            snapshotSequence: (snapshot) => snapshot.snapshotSequence,
            getHighWaterSequence: Effect.succeed(2),
            replay: () =>
              Stream.concat(
                Stream.fromEffect(PubSub.publish(live, newerLive)).pipe(Stream.drain),
                Stream.succeed(replayed),
              ),
          }).pipe(Stream.take(4), Stream.runCollect);
        }),
      ),
    );

    expect(Array.from(items)).toEqual([
      { kind: "snapshot", snapshot: { snapshotSequence: 1 } },
      { kind: "event", event: event(2) },
      { kind: "synchronized", sequence: 2 },
      { kind: "event", event: event(3) },
    ]);
  });

  it("emits the synchronized marker after the fenced replay even when live events are already buffered", async () => {
    const items = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* PubSub.unbounded<OrchestrationEvent>();
          return yield* makeCursorSafeSnapshotLiveStream({
            subscribeLive: PubSub.subscribe(live).pipe(
              Effect.map((subscription) => Stream.fromEffectRepeat(PubSub.take(subscription))),
            ),
            // Two live events land before the snapshot is even taken, so the
            // marker must still wait for the durable replay to drain.
            snapshot: PubSub.publish(live, event(2)).pipe(
              Effect.andThen(PubSub.publish(live, event(5))),
              Effect.as({ snapshotSequence: 1 }),
            ),
            snapshotSequence: (snapshot) => snapshot.snapshotSequence,
            getHighWaterSequence: Effect.succeed(4),
            replay: () => Stream.make(event(2), event(3), event(4)),
          }).pipe(Stream.take(6), Stream.runCollect);
        }),
      ),
    );

    expect(Array.from(items)).toEqual([
      { kind: "snapshot", snapshot: { snapshotSequence: 1 } },
      { kind: "event", event: event(2) },
      { kind: "event", event: event(3) },
      { kind: "event", event: event(4) },
      { kind: "synchronized", sequence: 4 },
      { kind: "event", event: event(5) },
    ]);
  });

  it("requires a fresh snapshot instead of replaying an unbounded attach gap", async () => {
    let replayStarted = false;
    const reports: Array<{
      readonly snapshotSequence: number;
      readonly highWaterSequence: number;
      readonly replayCount: number;
      readonly replayLimit: number;
    }> = [];
    const program = Effect.scoped(
      makeCursorSafeSnapshotLiveStream({
        subscribeLive: Effect.succeed(Stream.empty),
        snapshot: Effect.succeed({ snapshotSequence: 1 }),
        snapshotSequence: (snapshot) => snapshot.snapshotSequence,
        getHighWaterSequence: Effect.succeed(ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT + 2),
        onResnapshotRequired: (report) => Effect.sync(() => reports.push(report)),
        replay: () => {
          replayStarted = true;
          return Stream.empty;
        },
      }).pipe(Stream.runDrain),
    );

    await expect(Effect.runPromise(program)).rejects.toMatchObject({
      code: "ORCHESTRATION_RESNAPSHOT_REQUIRED",
      retryable: true,
    });
    expect(replayStarted).toBe(false);
    expect(reports).toEqual([
      {
        snapshotSequence: 1,
        highWaterSequence: ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT + 2,
        replayCount: ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT + 1,
        replayLimit: ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT,
      },
    ]);
  });
});
