// FILE: transportTeardown.ts
// Purpose: Shared teardown helper for browser suites that mount the real chat route graph.
// Layer: Web test support

/** Number of macrotask waits used to drain post-unmount work. */
const SETTLE_TICKS = 4;
/** Delay per tick; long enough for an MSW-backed WS round trip to come back. */
const SETTLE_TICK_MS = 50;

/**
 * Waits for the work the root route kicked off to finish before the WebSocket transport is
 * disposed.
 *
 * Unmounting stops React, but `__root`'s `ensureScopedSubscriptions` can still have a
 * `subscribeShell` / `getShellSnapshot` request in flight. Disposing the transport underneath it
 * makes `WsTransport.request` throw "Transport disposed", and because that refresh promise is
 * fire-and-forget (`__root.tsx`, `ensureScopedSubscriptions`) the rejection is unhandled: Vitest
 * then reports an unhandled error and exits non-zero even when every assertion passed.
 *
 * The real fix is for `ensureScopedSubscriptions` to swallow a rejection from a disposed transport
 * — teardown and reconnect both make that outcome expected, not exceptional. Until that lands,
 * call this between `unmount()` and `resetWsNativeApiForTest()` so the in-flight request settles
 * against a live transport.
 */
export async function settleInFlightTransportWork(): Promise<void> {
  for (let tick = 0; tick < SETTLE_TICKS; tick += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, SETTLE_TICK_MS);
    });
  }
}
