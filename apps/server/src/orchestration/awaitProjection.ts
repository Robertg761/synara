// FILE: awaitProjection.ts
// Purpose: Bounded wait for a just-dispatched aggregate to appear in the
//          read-model projection.
// Layer: Server orchestration
// Exports: awaitProjectedValue

import { Effect, Option } from "effect";

const DEFAULT_PROJECTION_POLL_MS = 25;

/**
 * Dispatch acceptance and projection are separate steps, so a caller that must
 * answer with the projected shell has to wait for it. Read failures are treated
 * as "not yet": the deadline, not a transient repository error, decides the
 * outcome, and `null` means the caller must not invent a result.
 */
export const awaitProjectedValue = <A>(
  read: Effect.Effect<Option.Option<A>, unknown>,
  options: { readonly timeoutMs: number; readonly pollMs?: number },
): Effect.Effect<A | null> =>
  Effect.gen(function* () {
    const pollMs = options.pollMs ?? DEFAULT_PROJECTION_POLL_MS;
    const deadline = Date.now() + options.timeoutMs;
    for (;;) {
      const value = yield* read.pipe(Effect.catch(() => Effect.succeed(Option.none<A>())));
      if (Option.isSome(value)) return value.value;
      if (Date.now() >= deadline) return null;
      yield* Effect.sleep(pollMs);
    }
  });
