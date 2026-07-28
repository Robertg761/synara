import type {
  MobileListDirectoriesInput,
  MobileListDirectoriesResult,
  MobileRootId,
  MobileWorkspaceRoot,
} from "@synara/contracts";
import { ServiceMap, type Effect } from "effect";

import type { MobileGatewayError } from "./MobileGateway.ts";

/**
 * A path the server resolved itself, never one the client reconstructed. Both
 * `rootPath` and `path` are canonical (symlinks already resolved) and `path` is
 * proven to be contained in `rootPath`.
 */
export interface MobileResolvedDirectory {
  readonly rootId: MobileRootId;
  readonly rootPath: string;
  /** Normalized, root-relative POSIX path. Empty string means the root itself. */
  readonly relativePath: string;
  readonly path: string;
}

/**
 * The mobile filesystem boundary: the owner's approved roots are the only
 * reachable part of the host, and iOS addresses them through opaque handles.
 */
export interface MobileWorkspaceAccessShape {
  readonly listRoots: Effect.Effect<ReadonlyArray<MobileWorkspaceRoot>>;
  /**
   * Resolves `rootId` + relative path to a canonical directory inside the
   * approved root, or fails with a typed rejection. Every mutation that takes a
   * mobile path must go through this.
   */
  readonly resolveDirectory: (
    input: MobileListDirectoriesInput,
  ) => Effect.Effect<MobileResolvedDirectory, MobileGatewayError>;
  readonly listDirectories: (
    input: MobileListDirectoriesInput,
  ) => Effect.Effect<MobileListDirectoriesResult, MobileGatewayError>;
}

export class MobileWorkspaceAccess extends ServiceMap.Service<
  MobileWorkspaceAccess,
  MobileWorkspaceAccessShape
>()("synara/mobile/Services/MobileWorkspaceAccess") {}
