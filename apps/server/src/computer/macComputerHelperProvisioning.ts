/**
 * Building and caching the native macOS computer-use helper.
 *
 * The helper resolves private Quartz/AppKit SPI at runtime whose symbols move
 * between macOS and Xcode releases, so — exactly like the iOS device helper —
 * a compiled binary is only valid for the toolchain that produced it and the
 * cache is keyed on that toolchain plus a digest of the helper's own sources
 * (so shipping a helper fix invalidates the cache the same way an Xcode upgrade
 * does). The two pure key/digest functions are shared with the device helper in
 * `@synara/shared/deviceHelperCache` rather than reimplemented here; only the
 * cache directory and binary name differ, because the two helpers must not
 * overwrite each other's builds.
 *
 * All filesystem and process access is injected so the whole module is
 * unit-testable on a Linux CI host that has no Xcode.
 *
 * @module computer/macComputerHelperProvisioning
 */
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

import {
  COMPUTER_HELPER_BINARY_NAME,
  COMPUTER_HELPER_BINARY_PATH_ENV,
} from "@synara/shared/computerHelperPaths";
import {
  deviceHelperCacheKey,
  readDeviceHelperSourceRevision,
} from "@synara/shared/deviceHelperCache";

/** `~/Library/Caches/synara/computer-helper` — its own directory, not the device helper's. */
export const COMPUTER_HELPER_CACHE_SEGMENTS = [
  "Library",
  "Caches",
  "synara",
  "computer-helper",
] as const;

/**
 * Operator override for the helper source directory. Nothing in the product
 * sets it: packaged desktop builds ship the signed binary and point at it with
 * `COMPUTER_HELPER_BINARY_PATH_ENV`, and the CLI finds its staged sources
 * beside the bundle. This exists so a source tree in an unusual location can
 * still be built from.
 */
export const COMPUTER_HELPER_SOURCE_DIR_ENV = "SYNARA_COMPUTER_HELPER_SOURCE_DIR";
export { COMPUTER_HELPER_BINARY_NAME };

export const COMPUTER_HELPER_CACHE_ROOT = path.join(homedir(), ...COMPUTER_HELPER_CACHE_SEGMENTS);

/**
 * Resolve the helper sources in both execution layouts.
 *
 * Source modules live under `src/computer`, while tsdown collapses the server
 * into `dist/index.*` and the build copies the helper beside that bundle.
 * Checking the bundled layout first makes packaged desktop and published CLI
 * builds use their staged asset without changing the development path. This is
 * the exact shape `resolveDeviceHelperSourceDir` uses for the device helper.
 */
export function resolveComputerHelperSourceDir(
  moduleDirectory: string,
  sourceExists: (candidate: string) => boolean = (candidate) =>
    existsSync(path.join(candidate, "build.sh")),
  configuredDirectory: string | undefined = process.env[COMPUTER_HELPER_SOURCE_DIR_ENV],
): string {
  if (configuredDirectory) {
    const external = path.resolve(configuredDirectory);
    if (sourceExists(external)) return external;
  }
  const bundled = path.resolve(moduleDirectory, "computer-use-macos");
  if (sourceExists(bundled)) return bundled;
  return path.resolve(moduleDirectory, "..", "..", "native", "computer-use-macos");
}

export interface ProcessRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface MacHelperProvisionerOptions {
  readonly helperSourceDir: string;
  readonly bundledBinaryPath?: string;
  readonly helperCacheRoot?: string;
  /** Runs a subprocess to completion; injected so tests never touch a real toolchain. */
  readonly run: (
    command: string,
    args: readonly string[],
    options: { readonly timeoutMs: number; readonly env?: NodeJS.ProcessEnv },
  ) => Promise<ProcessRunResult>;
  /** `true` when a file exists; defaults to a real `stat`. */
  readonly fileExists?: (candidate: string) => Promise<boolean>;
  readonly readSources?: (dir: string) => Promise<readonly string[]>;
  readonly readSourceFile?: (file: string) => Promise<string>;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * The build failed and will keep failing the same way until the toolchain or
 * the sources change, so the backend remembers this instead of retrying a build
 * on every action. Distinct type so `availability()` can turn it into a
 * `backend-unavailable` card rather than a generic error.
 */
export class MacHelperBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MacHelperBuildError";
  }
}

/**
 * Builds and caches the helper binary. One instance per backend; concurrent
 * callers of `ensureBinary` share a single compilation via the backend's own
 * memoization, so this class stays stateless beyond its injected IO.
 */
export class MacComputerHelperProvisioner {
  private readonly helperSourceDir: string;
  private readonly bundledBinaryPath: string | undefined;
  private readonly helperCacheRoot: string;
  /** Memoized `xcodebuild -version`; the active toolchain cannot change here. */
  private xcodeVersionPromise: Promise<string | null> | undefined;
  private readonly run: MacHelperProvisionerOptions["run"];
  private readonly fileExists: (candidate: string) => Promise<boolean>;
  private readonly readSources: (dir: string) => Promise<readonly string[]>;
  private readonly readSourceFile: (file: string) => Promise<string>;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: MacHelperProvisionerOptions) {
    this.helperSourceDir = options.helperSourceDir;
    this.bundledBinaryPath =
      options.bundledBinaryPath ??
      options.env?.[COMPUTER_HELPER_BINARY_PATH_ENV] ??
      process.env[COMPUTER_HELPER_BINARY_PATH_ENV];
    this.helperCacheRoot = options.helperCacheRoot ?? COMPUTER_HELPER_CACHE_ROOT;
    this.run = options.run;
    this.fileExists =
      options.fileExists ??
      ((candidate) =>
        stat(candidate).then(
          () => true,
          () => false,
        ));
    this.readSources = options.readSources ?? ((dir) => readdir(dir));
    this.readSourceFile = options.readSourceFile ?? ((file) => readFile(file, "utf8"));
    this.env = options.env ?? process.env;
  }

  /**
   * `xcodebuild -version`, run at most once per provisioner.
   *
   * `probeAvailability()` calls this twice over — once directly and once through
   * the cache key — and it runs at boot for every user on every platform check.
   * The active toolchain cannot change under a running server without a restart
   * (it is `xcode-select`'d machine state), so the spawn is memoized while the
   * source hash below is deliberately left live: sources *do* change while a
   * developer works, and a stale key there would serve a stale binary.
   */
  private async xcodeVersionOutput(): Promise<string | null> {
    this.xcodeVersionPromise ??= this.run("xcodebuild", ["-version"], {
      timeoutMs: 20_000,
      env: this.env,
    })
      .then((value) => (value.code === 0 ? value.stdout : null))
      .catch(() => null);
    return await this.xcodeVersionPromise;
  }

  /** Whether a full Xcode toolchain — not just the CLI tools — is present to build with. */
  async xcodeToolchainPresent(): Promise<boolean> {
    return (await this.xcodeVersionOutput()) !== null;
  }

  /** Signed helper shipped inside Synara.app, when this is a packaged desktop build. */
  async bundledBinary(): Promise<string | null> {
    const candidate = this.bundledBinaryPath?.trim();
    if (!candidate) return null;
    return (await this.fileExists(candidate)) ? candidate : null;
  }

  /** The cached binary path if one exists for the current toolchain and sources, else null. */
  async cachedBinaryPath(): Promise<string | null> {
    const key = await this.buildKey().catch(() => null);
    if (key === null) return null;
    const binaryPath = path.join(this.helperCacheRoot, key, COMPUTER_HELPER_BINARY_NAME);
    return (await this.fileExists(binaryPath)) ? binaryPath : null;
  }

  /**
   * The cached binary, or a fresh build of it. Throws `MacHelperBuildError` with
   * an actionable message when the toolchain is missing or the compile fails.
   */
  async ensureBinary(): Promise<string> {
    const bundled = await this.bundledBinary();
    if (bundled) return bundled;
    const cached = await this.cachedBinaryPath();
    if (cached) return cached;

    const key = await this.buildKey().catch(() => null);
    if (key === null) {
      throw new MacHelperBuildError(
        "Could not determine the Xcode version. Install Xcode and run: " +
          "sudo xcode-select -s /Applications/Xcode.app/Contents/Developer",
      );
    }
    const outputDirectory = path.join(this.helperCacheRoot, key);
    const buildScript = path.join(this.helperSourceDir, "build.sh");
    const result = await this.run("/bin/sh", [buildScript, outputDirectory], {
      // A cold Swift compile of the helper is minutes, not seconds; a false
      // timeout would throw away a build that was about to succeed.
      timeoutMs: 300_000,
      env: this.env,
    }).catch((error: unknown) => {
      throw new MacHelperBuildError(
        `Computer helper build could not start: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      throw new MacHelperBuildError(
        `Computer helper build failed${detail ? `: ${detail}` : ""}. ` +
          "Verify a full Xcode is installed and its license accepted (sudo xcodebuild -license accept).",
      );
    }
    const binaryPath = path.join(outputDirectory, COMPUTER_HELPER_BINARY_NAME);
    if (!(await this.fileExists(binaryPath))) {
      throw new MacHelperBuildError("Computer helper build produced no binary.");
    }
    return binaryPath;
  }

  private async buildKey(): Promise<string> {
    const versionOutput = await this.xcodeVersionOutput();
    const revision = await this.sourceRevision();
    const key = versionOutput === null ? null : deviceHelperCacheKey(versionOutput, revision);
    if (key === null) {
      throw new MacHelperBuildError("Could not determine the Xcode version.");
    }
    return key;
  }

  private async sourceRevision(): Promise<string | undefined> {
    return await readDeviceHelperSourceRevision(this.helperSourceDir, {
      listSources: (dir) => Promise.resolve(this.readSources(dir)) as Promise<readonly string[]>,
      readFile: (file) => this.readSourceFile(file),
      join: path.join,
    });
  }
}
