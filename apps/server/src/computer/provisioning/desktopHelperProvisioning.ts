/**
 * Getting the Tier 2 desktop helper onto a machine that has never seen it.
 *
 * The bar is the one `kwinPluginProvisioning.ts` already sets for KDE: a user
 * installs the update, turns computer use on, and it works. Tier 1 has met that
 * bar since it shipped — `KWinComputerBackend.availability()` provisions,
 * compiling from source on a cold machine, and loads the result. Tier 2 never
 * did. `resolveDesktopHelper` can *copy* a shipped binary, but no release has
 * ever shipped one, and nothing anywhere could *build* one. So every wlroots
 * and GNOME desktop without a hand-run `build.sh` had no path to a helper at
 * all, and — because the helper is also what reads the compositor's global list
 * — was told its desktop offered no protocols rather than that a binary was
 * missing.
 *
 * This is the missing half, deliberately shaped like Tier 1's:
 *
 * 1. `SYNARA_COMPUTER_HELPER`, when it points at something executable.
 * 2. An install whose stamp matches this build's helper sources.
 * 3. A binary shipped with this build that matches this system, checksum
 *    verified.
 * 4. A build from the sources that shipped with this build.
 * 5. Otherwise a refusal naming the packages this machine is missing.
 *
 * Step 4 is the one that matters most in practice today, because Linux Synara
 * runs from source and no release pipeline yet unpacks the prebuild workflow's
 * artifacts. Step 2 is the one that matters on *update*: the helper reports no
 * version of its own, so without a stamp an upgraded Synara would keep running
 * a binary compiled against last release's sources forever.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  desktopHelperPath,
  desktopHelperPrebuiltRoots,
  installExecutable,
  readDesktopHelperManifest,
  readHostSystem,
  selectDesktopHelperPrebuild,
  type DesktopHelperPrebuild,
  type HostSystem,
} from "../portal/desktopHelperInstall.ts";
import {
  fingerprintSourceTree,
  installStampPath,
  readInstallStamp,
  writeInstallStamp,
} from "./installStamp.ts";
import { verifyPrebuilt } from "./prebuiltVerification.ts";
import {
  desktopHelperToolchainGaps,
  describeToolchainGaps,
  executableExists,
  type ToolchainProbeDependencies,
} from "./toolchain.ts";

const execFileAsync = promisify(execFile);

/** Points at a checkout of `native/computer-desktop-helper`, for a developer. */
export const DESKTOP_HELPER_SOURCE_DIR_ENV = "SYNARA_COMPUTER_HELPER_SOURCE_DIR";

/**
 * A cold compile of six vendored protocols plus the helper itself is seconds,
 * not minutes, but a machine under load or on slow storage gets room.
 */
export const HELPER_BUILD_TIMEOUT_MS = 5 * 60_000;

export const BUILD_SCRIPT_PATH = "apps/server/native/computer-desktop-helper/build.sh";

export type DesktopHelperProvisionAction =
  | "already-current"
  | "installed-prebuilt"
  | "installed-from-source";

export interface DesktopHelperProvisionResult {
  readonly action: DesktopHelperProvisionAction;
  readonly path: string;
  /** One sentence for the availability card, in the user's terms. */
  readonly summary: string;
}

export class DesktopHelperProvisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopHelperProvisionError";
  }
}

export interface DesktopHelperProvisionDependencies extends ToolchainProbeDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly executableExists?: (path: string) => Promise<boolean>;
  /** Where shipped binaries live; `undefined` when this build ships none. */
  readonly prebuiltRoot?: string | undefined;
  /** Where `build.sh` and the helper sources live, when they shipped. */
  readonly sourceDirectory?: string | undefined;
  /** Compiles the helper and resolves the path it wrote. */
  readonly buildFromSource?: (sourceDirectory: string, env: NodeJS.ProcessEnv) => Promise<string>;
  /**
   * `/etc/os-release`, `process.arch` and the running glibc, which together are
   * the key a shipped binary is matched on. Injectable for the same reason the
   * toolchain probe is: otherwise the prebuilt path can only ever be exercised
   * on a machine that happens to be one of the distributions in the matrix.
   */
  readonly readOsRelease?: () => Promise<string | undefined>;
  readonly arch?: string;
  readonly glibc?: () => string | undefined;
  readonly now?: () => Date;
}

/**
 * Install the helper if this build's version of it is not already installed.
 *
 * Throws only when it cannot produce a helper at all, and the message always
 * names the next thing the user could do — install packages, or run the build
 * script themselves. Never asks, never prompts, and puts nothing on screen.
 */
export async function provisionDesktopHelper(
  dependencies: DesktopHelperProvisionDependencies = {},
): Promise<DesktopHelperProvisionResult> {
  const env = dependencies.env ?? process.env;
  const exists = dependencies.executableExists ?? executableExists;
  const path = desktopHelperPath(env);
  const override = env.SYNARA_COMPUTER_HELPER?.trim();

  // An operator who named a path named it as the answer. Nothing is built over
  // it and nothing is installed beside it; if it is broken, that is theirs to
  // fix and silently replacing it would hide that.
  if (override) {
    if (await exists(path)) {
      return {
        action: "already-current",
        path,
        summary: `Using the helper at ${path}, named by SYNARA_COMPUTER_HELPER.`,
      };
    }
    throw new DesktopHelperProvisionError(
      `SYNARA_COMPUTER_HELPER points at ${path}, which is not an executable file. ` +
        "Point it at a built helper, or unset it to let Synara install one.",
    );
  }

  const sourceDirectory = dependencies.sourceDirectory ?? locateHelperSources(env);
  const fingerprint = sourceDirectory ? await fingerprintSourceTree(sourceDirectory) : undefined;
  const stampPath = installStampPath(path);

  if (await exists(path)) {
    const installed = await readInstallStamp(stampPath);
    // An unstamped binary is one `build.sh` put there by hand, and replacing a
    // build the user made themselves is not this function's call to make. With
    // a stamp, staleness is judged against whatever version signal this build
    // carries: the shipped sources' fingerprint when there are sources, or —
    // in a build that ships only prebuilts — the shipped binary's checksum
    // against the checksum the stamp recorded. A build that carries neither
    // has nothing that could call the install stale.
    const current =
      installed === undefined ||
      (fingerprint !== undefined
        ? installed.fingerprint === fingerprint
        : !(await shippedPrebuiltSupersedes(installed.fingerprint, dependencies, env)));
    if (current) {
      return {
        action: "already-current",
        path,
        summary: "The desktop helper is installed and current.",
      };
    }
  }

  const prebuilt = await installShippedHelper(dependencies, env, path);
  if (prebuilt.installed) {
    await recordInstall(
      stampPath,
      fingerprint ?? `prebuilt:${prebuilt.installed.sha256}`,
      describeBuild(prebuilt.installed),
      dependencies,
    );
    return {
      action: "installed-prebuilt",
      path,
      summary: "The desktop helper that shipped with this build is installed and ready.",
    };
  }
  // A checksum failure is worth saying out loud even when a source build can
  // still rescue this machine: the file that shipped is not the file that was
  // built. It is carried into whatever happens next rather than thrown, so a
  // machine with a working toolchain is not left helper-less over a corrupted
  // download it never needed.
  const checksumFailure = prebuilt.checksumFailure;

  if (!sourceDirectory) {
    throw new DesktopHelperProvisionError(
      checksumFailure ??
        "No desktop helper shipped with this build for this system, and its sources are not " +
          `present either, so one could not be built. Point ${DESKTOP_HELPER_SOURCE_DIR_ENV} at a ` +
          `checkout of ${BUILD_SCRIPT_PATH}'s directory, or SYNARA_COMPUTER_HELPER at a helper you built.`,
    );
  }

  const gaps = await desktopHelperToolchainGaps(dependencies);
  if (gaps.length > 0) {
    throw new DesktopHelperProvisionError(
      `${checksumFailure ? `${checksumFailure} ` : ""}The desktop helper has to be compiled on ` +
        `this machine, and the tools to do it are not installed. ${describeToolchainGaps(gaps)}`,
    );
  }

  const build = dependencies.buildFromSource ?? buildHelperFromSource;
  let built: string;
  try {
    built = await build(sourceDirectory, env);
  } catch (error) {
    throw new DesktopHelperProvisionError(
      `${checksumFailure ? `${checksumFailure} ` : ""}The desktop helper failed to compile ` +
        `(${describe(error)}). You can run ${BUILD_SCRIPT_PATH} yourself to see the full output.`,
    );
  }
  // `build.sh` already writes to the install path when it is given no output
  // directory, so the common case is a no-op copy rather than a second write.
  if (built !== path) await installExecutable(built, path);
  await recordInstall(stampPath, fingerprint ?? "source", "built from source", dependencies);

  return {
    action: "installed-from-source",
    path,
    summary: checksumFailure
      ? `${checksumFailure} The helper was compiled from source instead and is ready.`
      : "The desktop helper was compiled for this machine and is ready.",
  };
}

/**
 * Whether provisioning could plausibly succeed, established without doing any
 * of it.
 *
 * The same one-way trade `KWinComputerBackend.probeAvailability()` documents: a
 * yes that turns out to be wrong costs the first real use one error card, which
 * is the same card provisioning already produces, while a no costs the user the
 * feature outright.
 */
export async function desktopHelperCouldExist(
  dependencies: DesktopHelperProvisionDependencies = {},
): Promise<boolean> {
  const env = dependencies.env ?? process.env;
  const exists = dependencies.executableExists ?? executableExists;
  if (await exists(desktopHelperPath(env))) return true;
  if (await selectShippedHelper(dependencies, env)) return true;
  const sourceDirectory = dependencies.sourceDirectory ?? locateHelperSources(env);
  if (!sourceDirectory) return false;
  return (await desktopHelperToolchainGaps(dependencies)).length === 0;
}

/**
 * Where the helper's sources are: bundled beside this module in a packaged
 * build, up in `native/` in a checkout. Mirrors
 * `resolveInstallScriptPath` in `KWinComputerBackend.ts`, which answers the
 * same question for the KWin plugin's installer.
 */
export function locateHelperSources(
  env: NodeJS.ProcessEnv = process.env,
  sourceExists: (candidate: string) => boolean = existsSync,
): string | undefined {
  const configured = env[DESKTOP_HELPER_SOURCE_DIR_ENV]?.trim();
  const candidates = [
    ...(configured ? [resolve(configured)] : []),
    fileURLToPath(new URL("./computer-desktop-helper/", import.meta.url)),
    fileURLToPath(new URL("../../../native/computer-desktop-helper/", import.meta.url)),
  ];
  return candidates.find((candidate) => sourceExists(join(candidate, "build.sh")));
}

/**
 * Runs the shipped build script, taking the path it prints.
 *
 * The same contract `buildPluginFromSource` uses for the KWin installer: the
 * script's last line of stdout is the artifact's path.
 */
async function buildHelperFromSource(
  sourceDirectory: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const script = join(sourceDirectory, "build.sh");
  const { stdout } = await execFileAsync("bash", [script], {
    timeout: HELPER_BUILD_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    env,
  });
  const path = stdout.trimEnd().split("\n").at(-1)?.trim();
  if (!path) throw new Error(`${BUILD_SCRIPT_PATH} printed no path.`);
  return path;
}

/** The shipped binary for this system, without installing it. */
async function selectShippedHelper(
  dependencies: DesktopHelperProvisionDependencies,
  env: NodeJS.ProcessEnv,
): Promise<{ readonly root: string; readonly build: DesktopHelperPrebuild } | undefined> {
  // The same candidate roots `resolveDesktopHelper` searches, from the same
  // function: a packaged build ships its prebuilts beside the bundle, and a
  // second hand-maintained list here is how the runtime once searched only the
  // checkout location while releases shipped to the packaged one.
  let system: HostSystem | undefined;
  for (const root of desktopHelperPrebuiltRoots(env, dependencies.prebuiltRoot)) {
    const manifest = await readDesktopHelperManifest(join(root, "manifest.json"));
    if (!manifest) continue;
    system ??= await readHostSystem({
      env,
      ...(dependencies.readOsRelease ? { readOsRelease: dependencies.readOsRelease } : {}),
      ...(dependencies.arch !== undefined ? { arch: dependencies.arch } : {}),
      ...(dependencies.glibc ? { glibc: dependencies.glibc } : {}),
    });
    const build = selectDesktopHelperPrebuild(manifest, system);
    if (build) return { root, build };
  }
  return undefined;
}

/**
 * Whether this build ships a prebuilt that supersedes the stamped install, for
 * builds that carry no sources. The prebuilt's checksum is the only version
 * signal such a build has: a stamp that recorded a different checksum is an
 * install from some other release. Stamps that recorded anything else — a
 * source fingerprint, "source" — cannot be compared to a checksum, and calling
 * them stale would replace a build the machine compiled for itself.
 */
async function shippedPrebuiltSupersedes(
  stampedFingerprint: string,
  dependencies: DesktopHelperProvisionDependencies,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (!stampedFingerprint.startsWith("prebuilt:")) return false;
  const shipped = await selectShippedHelper(dependencies, env);
  if (!shipped) return false;
  return stampedFingerprint !== `prebuilt:${shipped.build.sha256}`;
}

async function installShippedHelper(
  dependencies: DesktopHelperProvisionDependencies,
  env: NodeJS.ProcessEnv,
  destination: string,
): Promise<{
  readonly installed?: DesktopHelperPrebuild;
  /**
   * Set when a binary shipped for this system but was not the file that was
   * built. Reported rather than thrown, because a machine with a toolchain can
   * still compile its own helper — the caller folds this into whatever it says
   * next so the corruption is never silent.
   */
  readonly checksumFailure?: string;
}> {
  const shipped = await selectShippedHelper(dependencies, env);
  if (!shipped) return {};
  const source = join(shipped.root, shipped.build.file);
  if (!(await verifyPrebuilt(source, shipped.build.sha256))) {
    return {
      checksumFailure:
        `The helper binary shipped for ${describeBuild(shipped.build)} failed its checksum, so it ` +
        "was not installed; reinstalling Synara replaces it.",
    };
  }
  await installExecutable(source, destination);
  return { installed: shipped.build };
}

async function recordInstall(
  path: string,
  fingerprint: string,
  source: string,
  dependencies: DesktopHelperProvisionDependencies,
): Promise<void> {
  await writeInstallStamp(path, {
    fingerprint,
    source,
    installedAt: (dependencies.now?.() ?? new Date()).toISOString(),
  }).catch(() => undefined);
}

function describeBuild(build: DesktopHelperPrebuild): string {
  const version = build.osVersionId.trim();
  return `${build.osId}${version === "" ? "" : ` ${version}`} ${build.arch}`;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    // A failed compile puts the useful part on stderr, and execFile's own
    // message is only ever "Command failed".
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail = typeof stderr === "string" ? stderr.trim().split("\n").slice(-3).join(" ") : "";
    return detail === "" ? error.message : `${error.message}: ${detail}`;
  }
  return String(error);
}
