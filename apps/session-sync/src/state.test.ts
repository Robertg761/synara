// FILE: state.test.ts
// Purpose: Verifies once-only session decisions and crash-safe state persistence.
// Layer: Session-sync state tests

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  decideSessionAction,
  emptySessionSyncState,
  loadSessionSyncState,
  persistSessionSyncState,
  sessionKey,
} from "./state.ts";
import type { DiscoveredSession } from "./types.ts";

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeSession(overrides?: Partial<DiscoveredSession>): DiscoveredSession {
  return {
    provider: "claudeAgent",
    externalId: "session-1",
    cwd: "/repo",
    title: "Title",
    updatedAtMs: 1_000,
    ...overrides,
  };
}

it("imports unseen sessions outside the quiet period and defers fresh ones", () => {
  const state = emptySessionSyncState();
  const settled = makeSession();
  const fresh = makeSession({ externalId: "fresh", updatedAtMs: Date.now() - 1_000 });

  expect(decideSessionAction(state, settled, Date.now(), 120_000)).toEqual({ action: "import" });
  expect(decideSessionAction(state, fresh, Date.now(), 120_000)).toEqual({ action: "defer-quiet" });
});

it("never re-imports sessions already recorded", () => {
  let state = emptySessionSyncState();
  const session = makeSession({ provider: "codex", externalId: "019e-abc" });

  state = {
    version: 1,
    sessions: {
      [sessionKey(session)]: { status: "imported", threadId: "t-1", updatedAt: "now" },
    },
  };

  expect(decideSessionAction(state, session, Date.now(), 0)).toEqual({ action: "skip-seen" });
  // Even failures are terminal for the automatic pipeline; a manual retry path
  // can clear them deliberately.
  state = {
    version: 1,
    sessions: {
      [sessionKey(session)]: { status: "failed", error: "boom", updatedAt: "now" },
    },
  };
  expect(decideSessionAction(state, session, Date.now(), 0)).toEqual({ action: "skip-seen" });
});

it("round-trips state through disk atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "session-sync-state-"));
  tempRoots.push(dir);
  const path = join(dir, "nested", "state.json");

  persistSessionSyncState(path, {
    version: 1,
    sessions: { "claudeAgent:x": { status: "baseline-skipped", updatedAt: "now" } },
  });

  expect(loadSessionSyncState(path).sessions["claudeAgent:x"]?.status).toBe("baseline-skipped");
});

it("treats corrupt or unknown state files as empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "session-sync-state-"));
  tempRoots.push(dir);
  const path = join(dir, "state.json");
  writeFileSync(path, "{ not json", "utf8");

  expect(loadSessionSyncState(path)).toEqual(emptySessionSyncState());
});
