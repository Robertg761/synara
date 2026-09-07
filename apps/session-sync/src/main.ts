// FILE: main.ts
// Purpose: Background daemon that mirrors provider-native sessions into Synara.
// Layer: Session-sync entrypoint
//
// Every few seconds it discovers Claude Code transcripts and (optionally) codex
// app-server threads, then imports any session it has not yet handled through
// Synara's orchestration.importThread RPC. State is persisted so restarts never
// double-import. T3 Code, terminal CLIs, and any other harness that writes
// provider-native sessions are all covered by the same discovery.

import { loadSessionSyncConfig } from "./config.ts";
import { scanClaudeSessions } from "./providers/claudeCode.ts";
import { CodexAppServerPoller } from "./providers/codexAppServer.ts";
import { SynaraImporter } from "./importer.ts";
import { connectSynara, type SynaraConnection } from "./synara/synaraClient.ts";
import {
  decideSessionAction,
  loadSessionSyncState,
  persistSessionSyncState,
  sessionKey,
} from "./state.ts";
import type { DiscoveredSession, SessionSyncState } from "./types.ts";

const log = (message: string): void => {
  process.stdout.write(`[session-sync ${new Date().toISOString()}] ${message}\n`);
};

const warn = (message: string): void => {
  process.stderr.write(`[session-sync ${new Date().toISOString()}] WARN ${message}\n`);
};

let running = true;
process.on("SIGINT", () => {
  running = false;
});
process.on("SIGTERM", () => {
  running = false;
});

async function discoverSessions(
  config: ReturnType<typeof loadSessionSyncConfig>,
  codexPoller: CodexAppServerPoller | null,
): Promise<DiscoveredSession[]> {
  const sessions: DiscoveredSession[] = [];

  try {
    const claudeResult = await scanClaudeSessions(config.claudeRoot);
    sessions.push(...claudeResult.sessions);
    if (claudeResult.skippedMissingCwd > 0) {
      log(
        `${claudeResult.skippedMissingCwd} Claude transcript(s) had no working directory; skipped.`,
      );
    }
  } catch (cause) {
    warn(`Claude discovery failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  if (codexPoller) {
    try {
      const rows = await codexPoller.listAllThreads();
      for (const row of rows) {
        if (!row.cwd) continue;
        sessions.push({
          provider: "codex",
          externalId: row.id,
          cwd: row.cwd,
          title: row.title,
          updatedAtMs: row.updatedAtMs ?? Date.now(),
        });
      }
    } catch (cause) {
      warn(
        `Codex discovery failed: ${cause instanceof Error ? cause.message : String(cause)}${
          codexPoller.recentServerErrors()
            ? ` — ${codexPoller.recentServerErrors().split("\n").pop()}`
            : ""
        }`,
      );
    }
  }

  return sessions;
}

async function runTick(
  config: ReturnType<typeof loadSessionSyncConfig>,
  connectionRef: { value: SynaraConnection | null },
  stateRef: { value: SessionSyncState },
  codexPoller: CodexAppServerPoller | null,
  baselineMarkedRef: { value: boolean },
): Promise<void> {
  if (!connectionRef.value) {
    connectionRef.value = await connectSynara({
      baseUrl: config.synaraUrl,
      token: config.synaraToken,
      clientBuild: "session-sync",
    });
    log(`Connected to Synara at ${config.synaraUrl}.`);
  }
  const connection = connectionRef.value;

  // Baseline: an empty state on first contact records everything already on
  // disk as seen, so installing the daemon does not retroactively flood
  // Synara with old sessions unless SESSION_SYNC_BACKFILL=1 opts in.
  if (!baselineMarkedRef.value) {
    const discoveredForBaseline = await discoverSessions(config, codexPoller);
    let marked = 0;
    const nextSessions = { ...stateRef.value.sessions };
    for (const session of discoveredForBaseline) {
      const key = sessionKey(session);
      if (!config.backfillExisting && !nextSessions[key]) {
        nextSessions[key] = {
          status: "baseline-skipped",
          updatedAt: new Date().toISOString(),
        };
        marked += 1;
      }
    }
    stateRef.value = { version: 1, sessions: nextSessions };
    persistSessionSyncState(config.statePath, stateRef.value);
    baselineMarkedRef.value = true;
    if (marked > 0) log(`Baseline: recorded ${marked} existing session(s) as seen.`);
  }

  const discovered = await discoverSessions(config, codexPoller);
  if (discovered.length === 0) return;

  const nowMs = Date.now();
  const importer = new SynaraImporter(connection, {
    platform: process.platform,
    defaultClaudeModel: config.defaultClaudeModel,
    defaultCodexModel: config.defaultCodexModel,
  });

  let mutated = false;
  for (const session of discovered) {
    const decision = decideSessionAction(stateRef.value, session, nowMs, config.quietPeriodMs);
    if (decision.action !== "import") continue;

    try {
      const result = await importer.importSession(session);
      const key = sessionKey(session);
      const threadId = result.outcome === "imported" ? result.threadId : null;
      stateRef.value = {
        version: 1,
        sessions: {
          ...stateRef.value.sessions,
          [key]: {
            status: "imported",
            ...(threadId ? { threadId } : {}),
            updatedAt: new Date().toISOString(),
          },
        },
      };
      mutated = true;
      log(
        `Imported ${session.provider} session ${session.externalId.slice(0, 8)}${
          threadId ? ` → thread ${threadId.slice(0, 8)}` : " (already bound)"
        }.`,
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // Connection-level failures abort the tick; the loop reconnects and the
      // untouched state file makes this import retriable.
      if (/RPC socket|negotiate/i.test(message)) throw cause;
      warn(`${message}`);
      stateRef.value = {
        version: 1,
        sessions: {
          ...stateRef.value.sessions,
          [sessionKey(session)]: {
            status: "failed",
            error: message.slice(0, 500),
            updatedAt: new Date().toISOString(),
          },
        },
      };
      mutated = true;
    }
  }

  if (mutated) persistSessionSyncState(config.statePath, stateRef.value);
}

async function main(): Promise<void> {
  const config = loadSessionSyncConfig();
  log(`Synara URL: ${config.synaraUrl}`);
  log(`Claude root: ${config.claudeRoot}`);
  log(`State: ${config.statePath}`);
  log(
    `Codex discovery ${config.codexEnabled ? `enabled (${config.codexBin})` : "disabled"}; backfill ${
      config.backfillExisting ? "on" : "off"
    }.`,
  );

  const codexPoller = config.codexEnabled ? new CodexAppServerPoller(config.codexBin) : null;
  const connectionRef: { value: SynaraConnection | null } = { value: null };
  const stateRef = { value: loadSessionSyncState(config.statePath) };
  const baselineMarkedRef = { value: Object.keys(stateRef.value.sessions).length > 0 };

  for (;;) {
    if (!running) break;
    try {
      await runTick(config, connectionRef, stateRef, codexPoller, baselineMarkedRef);
    } catch (cause) {
      warn(cause instanceof Error ? cause.message : String(cause));
      if (connectionRef.value) {
        await connectionRef.value.close();
        connectionRef.value = null;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, config.scanIntervalMs));
  }

  codexPoller?.stop();
  await connectionRef.value?.close();
}

main().catch((error) => {
  warn(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
