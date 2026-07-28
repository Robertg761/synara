import { Effect, Semaphore } from "effect";

export interface KeyedLock {
  readonly withLock: <A, E, R>(
    key: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

/**
 * Serialize effects per key with a semaphore that only exists while somebody
 * holds or waits on it. Durable sagas key their whole critical section on the
 * operation identity, so a leaked per-key entry would be an unbounded leak in a
 * long-lived process.
 */
export const makeKeyedLock = Effect.gen(function* () {
  const index = yield* Semaphore.make(1);
  const locks = new Map<string, { readonly lock: Semaphore.Semaphore; users: number }>();

  const withLock = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      index.withPermits(1)(
        Effect.gen(function* () {
          const existing = locks.get(key);
          if (existing) {
            existing.users += 1;
            return existing;
          }
          const entry = { lock: yield* Semaphore.make(1), users: 1 };
          locks.set(key, entry);
          return entry;
        }),
      ),
      (entry) => entry.lock.withPermits(1)(effect),
      (entry) =>
        index.withPermits(1)(
          Effect.sync(() => {
            entry.users -= 1;
            if (entry.users === 0 && locks.get(key) === entry) locks.delete(key);
          }),
        ),
    );

  return { withLock } satisfies KeyedLock;
});
