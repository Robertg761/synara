// FILE: remoteAccessState.test.ts
// Purpose: Covers parsing, defaulting, and round-tripping of persisted remote-access state.

import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_REMOTE_ACCESS_PORT,
  DISABLED_REMOTE_ACCESS_STATE,
  parseDesktopRemoteAccessState,
  readDesktopRemoteAccessState,
  writeDesktopRemoteAccessState,
} from "./remoteAccessState";

const tempDirs: string[] = [];

function makeTempStatePath(): string {
  const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-remote-access-state-"));
  tempDirs.push(dir);
  return Path.join(dir, "remote-access.json");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    FS.rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseDesktopRemoteAccessState", () => {
  it("accepts a valid v2 state", () => {
    expect(
      parseDesktopRemoteAccessState({ version: 2, enabled: true, port: 3773, tunnel: true }),
    ).toEqual({
      version: 2,
      enabled: true,
      port: 3773,
      tunnel: true,
    });
  });

  it("upgrades a v1 file with the tunnel off", () => {
    expect(parseDesktopRemoteAccessState({ version: 1, enabled: true, port: 3773 })).toEqual({
      version: 2,
      enabled: true,
      port: 3773,
      tunnel: false,
    });
  });

  it.each([
    ["null", null],
    ["missing enabled", { version: 2, port: 3773, tunnel: false }],
    ["non-boolean enabled", { version: 2, enabled: "yes", port: 3773, tunnel: false }],
    ["non-boolean tunnel", { version: 2, enabled: true, port: 3773, tunnel: "yes" }],
    ["port zero", { version: 2, enabled: true, port: 0, tunnel: false }],
    ["port too large", { version: 2, enabled: true, port: 70000, tunnel: false }],
    ["fractional port", { version: 2, enabled: true, port: 3773.5, tunnel: false }],
  ])("rejects %s", (_label, value) => {
    expect(parseDesktopRemoteAccessState(value)).toBeNull();
  });
});

describe("readDesktopRemoteAccessState", () => {
  it("defaults to disabled on a missing or corrupt file", () => {
    const statePath = makeTempStatePath();
    expect(readDesktopRemoteAccessState(statePath)).toEqual(DISABLED_REMOTE_ACCESS_STATE);

    FS.writeFileSync(statePath, "{not json", "utf8");
    expect(readDesktopRemoteAccessState(statePath)).toEqual(DISABLED_REMOTE_ACCESS_STATE);
  });

  it("round-trips written state", () => {
    const statePath = makeTempStatePath();
    writeDesktopRemoteAccessState(statePath, {
      version: 2,
      enabled: true,
      port: 4881,
      tunnel: true,
    });
    expect(readDesktopRemoteAccessState(statePath)).toEqual({
      version: 2,
      enabled: true,
      port: 4881,
      tunnel: true,
    });
  });

  it("keeps the disabled default on the server's desktop port", () => {
    expect(DISABLED_REMOTE_ACCESS_STATE.port).toBe(DEFAULT_REMOTE_ACCESS_PORT);
  });
});
