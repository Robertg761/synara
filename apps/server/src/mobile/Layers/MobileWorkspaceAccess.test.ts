import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MobileApprovedRoot, MobileRootId } from "@synara/contracts";
import { toMobileApprovedRoot } from "@synara/shared/mobileAccess";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WorkspaceEntries } from "../../workspace/Services/WorkspaceEntries";
import { WorkspaceEntriesLive } from "../../workspace/Layers/WorkspaceEntries";
import { MobileGatewayError } from "../Services/MobileGateway";
import type { MobileWorkspaceAccessShape } from "../Services/MobileWorkspaceAccess";
import { makeMobileWorkspaceAccess } from "./MobileWorkspaceAccess";

const UNKNOWN_ROOT_ID = "root-000000000000dead" as MobileRootId;

let rootDirectory: string;
let outsideDirectory: string;
let approvedRoot: MobileApprovedRoot;

beforeAll(() => {
  // Canonical from the start: `/tmp` is a symlink on macOS, and every
  // containment check compares real paths.
  rootDirectory = realpathSync(mkdtempSync(join(tmpdir(), "synara-mobile-root-")));
  outsideDirectory = realpathSync(mkdtempSync(join(tmpdir(), "synara-mobile-outside-")));
  mkdirSync(join(rootDirectory, "app", "src"), { recursive: true });
  mkdirSync(join(rootDirectory, "app", ".git"), { recursive: true });
  mkdirSync(join(rootDirectory, "docs"), { recursive: true });
  writeFileSync(join(rootDirectory, "notes.txt"), "notes");
  symlinkSync(outsideDirectory, join(rootDirectory, "escape"), "dir");
  approvedRoot = toMobileApprovedRoot(rootDirectory);
});

afterAll(() => {
  rmSync(rootDirectory, { recursive: true, force: true });
  rmSync(outsideDirectory, { recursive: true, force: true });
});

const makeAccess = (
  options: { readonly homeDir?: string } = {},
): Promise<MobileWorkspaceAccessShape> =>
  Effect.gen(function* () {
    const workspaceEntries = yield* WorkspaceEntries;
    return makeMobileWorkspaceAccess({
      approvedRoots: [approvedRoot],
      workspaceEntries,
      homeDir: options.homeDir ?? "/nonexistent-home",
    });
  }).pipe(Effect.provide(WorkspaceEntriesLive), Effect.runPromise);

const runReject = (effect: Effect.Effect<unknown, MobileGatewayError>) =>
  effect.pipe(Effect.flip, Effect.runPromise);

const list = (access: MobileWorkspaceAccessShape, relativePath: string) =>
  access.listDirectories({ rootId: approvedRoot.rootId, relativePath });

describe("MobileWorkspaceAccess", () => {
  it("advertises roots as opaque handles with a home-abbreviated display path", async () => {
    const access = await makeAccess({ homeDir: rootDirectory });
    const roots = await Effect.runPromise(access.listRoots);

    expect(roots).toEqual([
      { rootId: approvedRoot.rootId, label: approvedRoot.label, displayPath: "~" },
    ]);
  });

  it("derives the same rootId after a restart of the layer", async () => {
    const first = await makeAccess();
    const second = await makeAccess();

    const [before, after] = await Promise.all([
      Effect.runPromise(first.listRoots),
      Effect.runPromise(second.listRoots),
    ]);
    expect(after[0]?.rootId).toBe(before[0]?.rootId);
    // Restart stability comes from the path itself, not from process state.
    expect(after[0]?.rootId).toBe(toMobileApprovedRoot(rootDirectory).rootId);
  });

  it("lists directories only, flagging git repositories", async () => {
    const access = await makeAccess();
    const result = await Effect.runPromise(list(access, ""));

    expect(result.relativePath).toBe("");
    expect(result.parentRelativePath).toBeNull();
    expect(result.entries).toEqual([
      { name: "app", relativePath: "app", isGitRepository: true },
      { name: "docs", relativePath: "docs", isGitRepository: false },
    ]);
  });

  it("reports the parent of a nested directory so the phone can walk back up", async () => {
    const access = await makeAccess();
    const result = await Effect.runPromise(list(access, "app"));

    expect(result.parentRelativePath).toBe("");
    expect(result.entries).toEqual([
      { name: "src", relativePath: "app/src", isGitRepository: false },
    ]);
  });

  it("rejects a root the owner never approved", async () => {
    const access = await makeAccess();
    const error = await runReject(
      access.listDirectories({ rootId: UNKNOWN_ROOT_ID, relativePath: "" }),
    );

    expect(error.error.code).toBe("path_not_authorized");
  });

  it.each([
    ["a parent traversal", ".."],
    ["a nested parent traversal", "app/../.."],
    ["an absolute path", "/etc"],
    ["a backslash path", "app\\src"],
    ["a NUL byte", "app\0"],
  ])("rejects %s", async (_label, relativePath) => {
    const access = await makeAccess();
    const error = await runReject(list(access, relativePath));

    expect(error.error.code).toBe("path_not_authorized");
  });

  it("rejects a symlink that escapes the approved root", async () => {
    const access = await makeAccess();
    const error = await runReject(list(access, "escape"));

    expect(error.error.code).toBe("path_not_authorized");
  });

  it("reports a directory that does not exist as not found", async () => {
    const access = await makeAccess();
    const error = await runReject(list(access, "missing"));

    expect(error.error.code).toBe("not_found");
  });

  it("refuses to browse a file as if it were a directory", async () => {
    const access = await makeAccess();
    const error = await runReject(list(access, "notes.txt"));

    expect(error.error.code).toBe("invalid_request");
  });
});
