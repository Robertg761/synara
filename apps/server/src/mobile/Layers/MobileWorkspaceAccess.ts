import { stat } from "node:fs/promises";
import { join } from "node:path";

import type {
  MobileApprovedRoot,
  MobileDirectoryEntry,
  MobileListDirectoriesInput,
  MobileRootId,
  MobileWorkspaceRoot,
} from "@synara/contracts";
import { Effect, Layer } from "effect";

import { ServerConfig } from "../../config.ts";
import {
  WorkspaceEntries,
  type WorkspaceEntriesShape,
} from "../../workspace/Services/WorkspaceEntries.ts";
import { resolveRealPathWithinRoot } from "../../workspace/realPathContainment.ts";
import { MobileGatewayError } from "../Services/MobileGateway.ts";
import {
  MobileWorkspaceAccess,
  type MobileResolvedDirectory,
  type MobileWorkspaceAccessShape,
} from "../Services/MobileWorkspaceAccess.ts";

const GIT_PROBE_CONCURRENCY = 16;

const isFileNotFoundError = (cause: unknown): boolean =>
  (cause as NodeJS.ErrnoException | null)?.code === "ENOENT";

/**
 * Second gate in front of the schema check: `resolveDirectory` is also called
 * from code paths whose input did not come off the wire, so the traversal rules
 * are enforced here too rather than assumed.
 */
const normalizeRelativePath = (relativePath: string): string | null => {
  if (relativePath.includes("\\") || relativePath.includes("\0")) return null;
  const segments = relativePath.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) return null;
  if (relativePath.startsWith("/")) return null;
  return segments.join("/");
};

const parentRelativePathOf = (relativePath: string): string | null => {
  if (relativePath === "") return null;
  const index = relativePath.lastIndexOf("/");
  return index === -1 ? "" : relativePath.slice(0, index);
};

export interface MobileWorkspaceAccessDependencies {
  /** Owner-approved roots, already canonicalized when the config was loaded. */
  readonly approvedRoots: ReadonlyArray<MobileApprovedRoot>;
  readonly workspaceEntries: Pick<WorkspaceEntriesShape, "listDirectories">;
  /** Abbreviated to `~` in the display path the phone renders. */
  readonly homeDir: string;
}

const toDisplayPath = (canonicalPath: string, homeDir: string): string =>
  homeDir.length > 0 && (canonicalPath === homeDir || canonicalPath.startsWith(`${homeDir}/`))
    ? `~${canonicalPath.slice(homeDir.length)}`
    : canonicalPath;

export const makeMobileWorkspaceAccess = (
  dependencies: MobileWorkspaceAccessDependencies,
): MobileWorkspaceAccessShape => {
  const rootsById = new Map<MobileRootId, MobileApprovedRoot>(
    dependencies.approvedRoots.map((root) => [root.rootId, root]),
  );

  const listRoots = Effect.succeed(
    dependencies.approvedRoots.map(
      (root): MobileWorkspaceRoot => ({
        rootId: root.rootId,
        label: root.label,
        displayPath: toDisplayPath(root.path, dependencies.homeDir),
      }),
    ),
  );

  const resolveDirectory = Effect.fn(function* (input: MobileListDirectoriesInput) {
    const root = rootsById.get(input.rootId);
    if (root === undefined) {
      return yield* MobileGatewayError.of(
        "path_not_authorized",
        `Workspace root ${input.rootId} is not an approved mobile root.`,
      );
    }
    const relativePath = normalizeRelativePath(input.relativePath);
    if (relativePath === null) {
      return yield* MobileGatewayError.of(
        "path_not_authorized",
        "The requested path is not a normalized relative path inside the approved root.",
      );
    }

    const candidate = relativePath === "" ? root.path : join(root.path, relativePath);
    // String containment cannot see symlinks, so containment is decided on the
    // canonical paths of both sides.
    const canonical = yield* Effect.tryPromise({
      try: () => resolveRealPathWithinRoot(root.path, candidate),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((cause) =>
        Effect.fail(
          isFileNotFoundError(cause)
            ? MobileGatewayError.of("not_found", "The requested directory does not exist.")
            : MobileGatewayError.of("internal_error", "The directory could not be resolved.", {
                retryable: true,
              }),
        ),
      ),
    );
    if (canonical === null) {
      return yield* MobileGatewayError.of(
        "path_not_authorized",
        "The requested path resolves outside its approved workspace root.",
      );
    }

    const isDirectory = yield* Effect.tryPromise({
      try: () => stat(canonical).then((entry) => entry.isDirectory()),
      catch: (cause) => cause,
    }).pipe(Effect.catch(() => Effect.succeed(false)));
    if (!isDirectory) {
      return yield* MobileGatewayError.of(
        "invalid_request",
        "The requested path is not a directory.",
      );
    }

    return {
      rootId: root.rootId,
      rootPath: root.path,
      relativePath,
      path: canonical,
    } satisfies MobileResolvedDirectory;
  });

  const isGitRepository = (directory: string) =>
    Effect.tryPromise({
      try: () => stat(join(directory, ".git")).then(() => true),
      catch: (cause) => cause,
    }).pipe(Effect.catch(() => Effect.succeed(false)));

  const listDirectories = Effect.fn(function* (input: MobileListDirectoriesInput) {
    const resolved = yield* resolveDirectory(input);
    // Same browse implementation the web folder picker uses, so mobile and web
    // agree on what a directory listing is (ordering, `.git` exclusion, limits).
    const listed = yield* dependencies.workspaceEntries
      .listDirectories({
        cwd: resolved.rootPath,
        ...(resolved.relativePath === "" ? {} : { relativePath: resolved.relativePath }),
      })
      .pipe(
        Effect.mapError(() =>
          MobileGatewayError.of("internal_error", "The directory could not be listed.", {
            retryable: true,
          }),
        ),
      );

    const entries = yield* Effect.forEach(
      listed.entries.filter((entry) => entry.kind === "directory"),
      (entry) =>
        isGitRepository(join(resolved.path, entry.name)).pipe(
          Effect.map(
            (gitRepository): MobileDirectoryEntry => ({
              name: entry.name,
              relativePath: entry.path,
              isGitRepository: gitRepository,
            }),
          ),
        ),
      { concurrency: GIT_PROBE_CONCURRENCY },
    );

    return {
      rootId: resolved.rootId,
      relativePath: resolved.relativePath,
      parentRelativePath: parentRelativePathOf(resolved.relativePath),
      entries,
    };
  });

  return { listRoots, resolveDirectory, listDirectories } satisfies MobileWorkspaceAccessShape;
};

export const MobileWorkspaceAccessLive = Layer.effect(
  MobileWorkspaceAccess,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const workspaceEntries = yield* WorkspaceEntries;
    return makeMobileWorkspaceAccess({
      approvedRoots: config.mobileAccess.approvedRoots,
      workspaceEntries,
      homeDir: config.homeDir,
    });
  }),
);
