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
  it("accepts a valid persisted state", () => {
    expect(parseDesktopRemoteAccessState({ version: 1, enabled: true, port: 3773 })).toEqual({
      version: 1,
      enabled: true,
      port: 3773,
    });
  });

  it.each([
    ["null", null],
    ["wrong version", { version: 2, enabled: true, port: 3773 }],
    ["missing enabled", { version: 1, port: 3773 }],
    ["non-boolean enabled", { version: 1, enabled: "yes", port: 3773 }],
    ["port zero", { version: 1, enabled: true, port: 0 }],
    ["port too large", { version: 1, enabled: true, port: 70000 }],
    ["fractional port", { version: 1, enabled: true, port: 3773.5 }],
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
    writeDesktopRemoteAccessState(statePath, { version: 1, enabled: true, port: 4881 });
    expect(readDesktopRemoteAccessState(statePath)).toEqual({
      version: 1,
      enabled: true,
      port: 4881,
    });
  });

  it("keeps the disabled default on the server's desktop port", () => {
    expect(DISABLED_REMOTE_ACCESS_STATE.port).toBe(DEFAULT_REMOTE_ACCESS_PORT);
  });
});
