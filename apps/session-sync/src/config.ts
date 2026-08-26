// FILE: config.ts
// Purpose: Resolves daemon configuration from flags, environment, and Synara's runtime file.
// Layer: Session-sync configuration

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SessionSyncConfig {
  readonly synaraUrl: string;
  readonly synaraToken: string | null;
  readonly statePath: string;
  readonly scanIntervalMs: number;
  /** Sessions modified more recently than this are deferred to a later tick. */
  readonly quietPeriodMs: number;
  readonly claudeRoot: string;
  readonly codexEnabled: boolean;
  readonly codexBin: string;
  readonly codexPollIntervalMs: number;
  /** First run with an empty state marks every existing session as seen instead of importing. */
  readonly backfillExisting: boolean;
  readonly defaultClaudeModel: string;
  readonly defaultCodexModel: string;
}

function intEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boolEnv(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

/**
 * Desktop and server instances record their listen address in
 * `<synara-home>/userdata/server-runtime.json`; reading it keeps the daemon
 * pointed at the running instance without hardcoding ports.
 */
function resolveSynaraUrlFromRuntimeFile(): string | null {
  const candidates = [
    process.env.SESSION_SYNC_RUNTIME_FILE,
    join(homedir(), ".synara", "userdata", "server-runtime.json"),
  ].filter((path): path is string => typeof path === "string");
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (
        parsed &&
        typeof parsed === "object" &&
        "origin" in parsed &&
        typeof (parsed as { origin?: unknown }).origin === "string"
      ) {
        return (parsed as { origin: string }).origin;
      }
    } catch {
      // Fall through to the next candidate; a torn write must not crash startup.
    }
  }
  return null;
}

export function loadSessionSyncConfig(env: NodeJS.ProcessEnv = process.env): SessionSyncConfig {
  const synaraUrl =
    env.SESSION_SYNC_URL ?? resolveSynaraUrlFromRuntimeFile() ?? "http://127.0.0.1:33853";

  const claudeConfigDir =
    env.SESSION_SYNC_CLAUDE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

  const xdgState = env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");

  return {
    synaraUrl,
    synaraToken: env.SESSION_SYNC_TOKEN ?? env.SYNARA_AUTH_TOKEN ?? null,
    statePath: env.SESSION_SYNC_STATE_PATH ?? join(xdgState, "synara-session-sync", "state.json"),
    scanIntervalMs: intEnv(env.SESSION_SYNC_SCAN_INTERVAL_MS, 15_000),
    quietPeriodMs: intEnv(env.SESSION_SYNC_QUIET_MS, 120_000),
    claudeRoot: env.SESSION_SYNC_CLAUDE_ROOT ?? join(claudeConfigDir, "projects"),
    codexEnabled: !boolEnv(env.SESSION_SYNC_DISABLE_CODEX),
    codexBin: env.SESSION_SYNC_CODEX_BIN ?? "codex",
    codexPollIntervalMs: intEnv(env.SESSION_SYNC_CODEX_POLL_MS, 20_000),
    backfillExisting: boolEnv(env.SESSION_SYNC_BACKFILL),
    defaultClaudeModel: env.SESSION_SYNC_DEFAULT_CLAUDE_MODEL ?? "claude-sonnet-5",
    defaultCodexModel: env.SESSION_SYNC_DEFAULT_CODEX_MODEL ?? "gpt-5.6-sol",
  };
}
