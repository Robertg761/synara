// FILE: remoteAccessState.ts
// Purpose: Persists the desktop remote-access configuration (enabled + pinned port).
// Layer: Desktop main process

import * as FS from "node:fs";
import * as Path from "node:path";

/** Matches the server's desktop-mode default port so remote URLs stay stable. */
export const DEFAULT_REMOTE_ACCESS_PORT = 3773;

export interface PersistedDesktopRemoteAccessState {
  readonly version: 1;
  readonly enabled: boolean;
  readonly port: number;
}

export const DISABLED_REMOTE_ACCESS_STATE: PersistedDesktopRemoteAccessState = {
  version: 1,
  enabled: false,
  port: DEFAULT_REMOTE_ACCESS_PORT,
};

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

export function parseDesktopRemoteAccessState(
  value: unknown,
): PersistedDesktopRemoteAccessState | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.enabled !== "boolean" ||
    !isValidPort(candidate.port)
  ) {
    return null;
  }
  return {
    version: 1,
    enabled: candidate.enabled,
    port: candidate.port,
  };
}

export function readDesktopRemoteAccessState(filePath: string): PersistedDesktopRemoteAccessState {
  try {
    return (
      parseDesktopRemoteAccessState(JSON.parse(FS.readFileSync(filePath, "utf8"))) ??
      DISABLED_REMOTE_ACCESS_STATE
    );
  } catch {
    return DISABLED_REMOTE_ACCESS_STATE;
  }
}

export function writeDesktopRemoteAccessState(
  filePath: string,
  state: PersistedDesktopRemoteAccessState,
): void {
  FS.mkdirSync(Path.dirname(filePath), { recursive: true });
  FS.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
