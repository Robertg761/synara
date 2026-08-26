/**
 * Where the desktop helper is, and how a binary that shipped with the app gets
 * there.
 *
 * The helper is the C process that owns the Wayland connection on every Tier 2
 * desktop, and until now the only way to have one was to run `build.sh` — which
 * needs a compiler, pkg-config, wayland-scanner, and two sets of development
 * headers on the user's own machine. That is the same ask that made the KWin
 * plugin unusable for anyone who had not already installed a toolchain, and it
 * is worse here: a packaged Synara ships no `native/` sources at all, so the
 * script the refusal names is not even on that machine to run.
 *
 * So `.github/workflows/desktop-helper-prebuilds.yml` builds the binaries in
 * distribution containers and this module installs one. The order is:
 *
 * 1. `SYNARA_COMPUTER_HELPER`, when it points at something executable.
 * 2. Whatever `build.sh` left at the default path.
 * 3. A binary shipped with this build that matches this system, checksum
 *    verified, copied into the default path.
 * 4. Nothing — and the refusal keeps naming `build.sh`, because it is still the
 *    answer for a system no container in the matrix resembles.
 *
 * ## The matching key, and why it is this one
 *
 * The KWin plugin matches on an exact KWin version because that is the one
 * thing that decides whether it loads. The helper has no such number: it is an
 * ordinary ELF binary linked against the build container's libwayland-client,
 * libxkbcommon, and glibc, so what decides whether it runs is the *system* it
 * was built on. `/etc/os-release`'s `ID` and `VERSION_ID` name that system
 * exactly, are a two-line file read with no process spawned, and are already
 * what a distribution's own packaging keys on — so `(ID, VERSION_ID, arch)` is
 * the key, matched exactly first, for the same reason the plugin is: a near
 * miss does not degrade, it fails at `execve` with a message about a missing
 * `.so` that no user can act on.
 *
 * Rolling distributions are the one place exactness cannot be spelled that way.
 * Arch publishes no `VERSION_ID` at all and Tumbleweed publishes a snapshot
 * date that a user's machine will never equal, so an entry carrying either
 * would be an entry that can never match. Those are built with an empty version
 * — read here as "this ID, any version" — and the manifest's recorded build
 * glibc is what keeps that safe: glibc is backwards compatible but not
 * forwards, so a binary built against a newer glibc than the host has would
 * fail to start, and that entry is skipped rather than installed.
 *
 * ## The lineage fallback, and what keeps it honest
 *
 * Exact matching alone writes off most of the Linux desktop population: Mint,
 * Pop!_OS, and elementary are `ID_LIKE=ubuntu`; Manjaro, EndeavourOS, and
 * CachyOS are `ID_LIKE=arch`; Rocky and Alma name `fedora` in theirs; and a
 * fresh Fedora release ages every versioned entry out of the manifest until the
 * matrix catches up. When nothing matches exactly, a build from the host's own
 * lineage — its `ID`, then each entry of `ID_LIKE` in the order the
 * distribution wrote them — is tried instead. That path is only taken when both
 * the host's glibc and the build's recorded glibc are known, because on it the
 * version key means nothing (Mint 22's `VERSION_ID` is not Ubuntu's) and the
 * glibc floor is the entire guard against the `execve` failure above. Among the
 * candidates that fit, the closest ancestor wins, then the highest glibc,
 * because the build linked against the newest libraries that still fit is the
 * one compiled on the system most like this one.
 */
import { access, chmod, constants, copyFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyPrebuilt } from "../provisioning/prebuiltVerification.ts";

/** Points at a directory of prebuilt helpers, for a packager or a developer. */
export const DESKTOP_HELPER_PREBUILT_DIR_ENV = "SYNARA_COMPUTER_HELPER_PREBUILT_DIR";

const MANIFEST_NAME = "manifest.json";
const HELPER_BINARY_NAME = "synara-computer-desktop-helper";

/** One binary in the shipped manifest, as the prebuild workflow writes it. */
export interface DesktopHelperPrebuild {
  /** `/etc/os-release` `ID` of the system it was compiled on. */
  readonly osId: string;
  /** `VERSION_ID`, or empty for a rolling distribution that has no useful one. */
  readonly osVersionId: string;
  /** `process.arch` spelling: `x64` or `arm64`. */
  readonly arch: string;
  /** glibc it was linked against; a floor, not an equality. Absent means unrecorded. */
  readonly glibc?: string;
  /** File name inside the prebuilt root. */
  readonly file: string;
  readonly sha256: string;
  /** The matrix job that produced it, for the message when it fails its checksum. */
  readonly builtOn?: string;
}

export interface DesktopHelperPrebuiltManifest {
  readonly builds: readonly DesktopHelperPrebuild[];
}

/** The machine being matched against, as cheaply as it can be established. */
export interface HostSystem {
  readonly osId: string;
  readonly osVersionId: string;
  readonly arch: string;
  readonly glibc?: string;
  /** `ID_LIKE` ancestors, closest first, for the lineage fallback. */
  readonly idLike?: readonly string[];
}

export type DesktopHelperSource = "override" | "installed" | "prebuilt";

export interface DesktopHelperResolution {
  /** The executable, absent when there is none and none could be installed. */
  readonly path?: string;
  readonly source?: DesktopHelperSource;
  /**
   * Why no shipped binary was installed, as one sentence to append to the
   * refusal that names `build.sh`. Absent exactly when `path` is set.
   */
  readonly note?: string;
}

export interface DesktopHelperResolutionDependencies {
  readonly env?: NodeJS.ProcessEnv;
  /** Whether a path exists and is executable. */
  readonly executableExists?: (path: string) => Promise<boolean>;
  /**
   * Where the shipped binaries live. Given explicitly this is the only place
   * looked at, which is what keeps a test off whatever the developer's checkout
   * happens to contain.
   */
  readonly prebuiltRoot?: string | undefined;
  /** The `os-release` file's text, or undefined when this system has none. */
  readonly readOsRelease?: () => Promise<string | undefined>;
  readonly arch?: string;
  /** The running glibc, or undefined when it cannot be read. */
  readonly glibc?: () => string | undefined;
}

/**
 * Where the native desktop helper lives. `SYNARA_COMPUTER_HELPER` overrides it
 * so a developer build and a packaged one are the same code path.
 */
export function desktopHelperPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SYNARA_COMPUTER_HELPER?.trim();
  if (override) return override;
  return join(
    env.XDG_DATA_HOME?.trim() || join(env.HOME ?? "", ".local", "share"),
    "synara",
    "computer",
    HELPER_BINARY_NAME,
  );
}

/**
 * The helper this machine can run, installing a shipped binary if that is what
 * it takes.
 *
 * Never throws and never asks: the whole point is that a user who turned on a
 * setting gets a working helper without being handed a build script, so every
 * failure along the way becomes a sentence rather than an exception.
 */
export async function resolveDesktopHelper(
  dependencies: DesktopHelperResolutionDependencies = {},
): Promise<DesktopHelperResolution> {
  const env = dependencies.env ?? process.env;
  const executableExists = dependencies.executableExists ?? defaultExecutableExists;
  const override = env.SYNARA_COMPUTER_HELPER?.trim();
  const path = desktopHelperPath(env);

  if (await executableExists(path)) {
    return { path, source: override ? "override" : "installed" };
  }
  // An operator who named a path named it as the answer. Installing a different
  // binary somewhere else would leave the override still pointing at nothing,
  // and installing over the override would replace a build they chose.
  if (override) {
    return {
      note: `SYNARA_COMPUTER_HELPER points at this path, so no binary shipped with this build was installed over it.`,
    };
  }

  const shipped = await locatePrebuilt(dependencies, env);
  if (!shipped) {
    return { note: "No prebuilt helpers ship with this build, so there was nothing to install." };
  }

  const system = await readHostSystem(dependencies);
  const build = selectDesktopHelperPrebuild(shipped.manifest, system);
  if (!build) {
    const count = shipped.manifest.builds.length;
    return {
      note:
        (count === 1
          ? "The one helper binary shipped with this build was not built"
          : `None of the ${count} helper binaries shipped with this build were built`) +
        ` for this system (${describeSystem(system)}).`,
    };
  }

  const source = join(shipped.root, build.file);
  if (!(await verifyPrebuilt(source, build.sha256))) {
    // Not silently ignored: a checksum failure means the file that shipped is
    // not the file that was built, and that is worth saying out loud rather
    // than letting it read as "your distribution is not covered".
    return {
      note:
        `The helper binary shipped for ${describeBuild(build)} failed its checksum, so it was not ` +
        "installed. Reinstalling Synara replaces it.",
    };
  }

  try {
    await installExecutable(source, path);
  } catch (error) {
    return {
      note: `The helper binary shipped for ${describeBuild(build)} could not be installed at ${path} (${describe(error)}).`,
    };
  }
  return { path, source: "prebuilt" };
}

/**
 * Exact on the identity first, then the lineage fallback; a floor on the glibc
 * either way.
 *
 * An entry with an empty `osVersionId` is a rolling distribution's, and matches
 * any version of that ID — see the module header for why that is the only
 * spelling available there, why the glibc floor is what makes it safe, and what
 * keeps the fallback honest.
 */
export function selectDesktopHelperPrebuild(
  manifest: DesktopHelperPrebuiltManifest,
  system: HostSystem,
): DesktopHelperPrebuild | undefined {
  const exact = manifest.builds.find((build) => {
    if (!same(build.arch, system.arch)) return false;
    if (!same(build.osId, system.osId)) return false;
    const version = build.osVersionId.trim();
    if (version !== "" && !same(version, system.osVersionId)) return false;
    return glibcIsAvailable(build.glibc, system.glibc);
  });
  return exact ?? selectByLineage(manifest, system);
}

/**
 * The nearest build in this host's lineage: its own ID at a version the
 * manifest no longer carries, then each `ID_LIKE` ancestor in the order the
 * distribution wrote them. Only entered with the glibc on both sides known —
 * on this path the version key means nothing and the floor is the whole guard.
 */
function selectByLineage(
  manifest: DesktopHelperPrebuiltManifest,
  system: HostSystem,
): DesktopHelperPrebuild | undefined {
  if (!system.glibc) return undefined;
  const lineage = [system.osId, ...(system.idLike ?? [])]
    .map((id) => id.trim().toLowerCase())
    .filter((id) => id !== "");
  let best: DesktopHelperPrebuild | undefined;
  let bestRank = Number.POSITIVE_INFINITY;
  let bestGlibc = "";
  for (const build of manifest.builds) {
    if (!same(build.arch, system.arch)) continue;
    if (!build.glibc || !glibcIsAvailable(build.glibc, system.glibc)) continue;
    const rank = lineage.indexOf(build.osId.trim().toLowerCase());
    if (rank === -1) continue;
    if (rank < bestRank || (rank === bestRank && compareVersions(build.glibc, bestGlibc) > 0)) {
      best = build;
      bestRank = rank;
      bestGlibc = build.glibc;
    }
  }
  return best;
}

/** Reads a manifest, dropping any entry that could not be acted on anyway. */
export async function readDesktopHelperManifest(
  path: string,
): Promise<DesktopHelperPrebuiltManifest | undefined> {
  const raw = await readFile(path, "utf8").catch(() => undefined);
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const builds = (parsed as { builds?: unknown }).builds;
  if (!Array.isArray(builds)) return undefined;
  return {
    builds: builds.flatMap((entry) => {
      const record = entry as Partial<DesktopHelperPrebuild> | null;
      if (!record || typeof record !== "object") return [];
      const { osId, arch, file, sha256 } = record;
      if (!isText(osId) || !isText(arch) || !isText(file) || !isText(sha256)) return [];
      // A path in the manifest is a path out of the prebuilt root; the file name
      // is all this ever needs, so anything else is refused rather than resolved.
      if (file.includes("/") || file.includes("\\") || file === "." || file === "..") return [];
      return [
        {
          osId,
          osVersionId: isText(record.osVersionId) ? record.osVersionId : "",
          arch,
          file,
          sha256,
          ...(isText(record.glibc) ? { glibc: record.glibc } : {}),
          ...(isText(record.builtOn) ? { builtOn: record.builtOn } : {}),
        } satisfies DesktopHelperPrebuild,
      ];
    }),
  };
}

/**
 * `ID=fedora`, `VERSION_ID="44"`, and `ID_LIKE="ubuntu debian"` — quotes
 * stripped, the space-separated ancestors kept in the order the distribution
 * wrote them, everything else ignored.
 */
export function parseOsRelease(text: string): {
  readonly osId: string;
  readonly osVersionId: string;
  readonly idLike: readonly string[];
} {
  let osId = "";
  let osVersionId = "";
  let idLike: readonly string[] = [];
  for (const line of text.split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (key !== "ID" && key !== "VERSION_ID" && key !== "ID_LIKE") continue;
    const value = unquote(line.slice(separator + 1).trim());
    if (key === "ID") osId = value;
    else if (key === "VERSION_ID") osVersionId = value;
    else idLike = value.split(/\s+/).filter((entry) => entry !== "");
  }
  return { osId, osVersionId, idLike };
}

/** What this machine is, for the manifest to be matched against. */
export async function readHostSystem(
  dependencies: DesktopHelperResolutionDependencies = {},
): Promise<HostSystem> {
  const text = await (dependencies.readOsRelease ?? defaultReadOsRelease)();
  const { osId, osVersionId, idLike } = parseOsRelease(text ?? "");
  const glibc = (dependencies.glibc ?? runtimeGlibcVersion)();
  return {
    osId,
    osVersionId,
    idLike,
    arch: dependencies.arch ?? process.arch,
    ...(glibc ? { glibc } : {}),
  };
}

/**
 * The glibc the process is running on, read from Node's own diagnostic header
 * rather than by spawning `ldd`.
 *
 * Absent on a musl system and on any build without the report, which is read as
 * "no constraint": the os-release ID already carries the system's identity, and
 * this is a second opinion on rolling entries rather than the decision.
 */
export function runtimeGlibcVersion(): string | undefined {
  try {
    const header = (process.report?.getReport() as { header?: Record<string, unknown> } | undefined)
      ?.header;
    const version = header?.glibcVersionRuntime;
    return typeof version === "string" && version.trim() !== "" ? version.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** True when a binary needing `required` can run on a host that has `available`. */
export function glibcIsAvailable(
  required: string | undefined,
  available: string | undefined,
): boolean {
  if (!required || !available) return true;
  return compareVersions(required, available) <= 0;
}

/**
 * Installed through a temporary name in the destination directory, for the same
 * reason `build.sh` does it: a rename is atomic, so a helper that is starting
 * right now sees either the old binary or the new one and never half of either.
 */
export async function installExecutable(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const staged = `${destination}.${process.pid}.partial`;
  try {
    await copyFile(source, staged);
    await chmod(staged, 0o755);
    await rename(staged, destination);
  } catch (error) {
    await rm(staged, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function locatePrebuilt(
  dependencies: DesktopHelperResolutionDependencies,
  env: NodeJS.ProcessEnv,
): Promise<
  { readonly root: string; readonly manifest: DesktopHelperPrebuiltManifest } | undefined
> {
  for (const root of prebuiltRoots(dependencies, env)) {
    const manifest = await readDesktopHelperManifest(join(root, MANIFEST_NAME));
    if (manifest) return { root, manifest };
  }
  return undefined;
}

/**
 * Where a shipped binary could be, in the order they are believed.
 *
 * The packaged location is a sibling of the bundle, the way the AT-SPI helper
 * script is, and the checkout location is the directory the prebuild workflow's
 * artifact unpacks over — so a developer who downloads that artifact gets the
 * same code path a user does. Exported because provisioning answers the same
 * question — a second list of candidates is a second place for the packaged
 * root to be forgotten, which is exactly how the runtime once looked only in
 * the checkout location while releases shipped to the packaged one.
 */
export function desktopHelperPrebuiltRoots(
  env: NodeJS.ProcessEnv,
  override?: string,
): readonly string[] {
  if (override) return [override];
  const configured = env[DESKTOP_HELPER_PREBUILT_DIR_ENV]?.trim();
  if (configured) return [configured];
  return [
    fileURLToPath(new URL("./computer-desktop-helper/prebuilt/", import.meta.url)),
    fileURLToPath(new URL("../../../native/computer-desktop-helper/prebuilt/", import.meta.url)),
  ];
}

function prebuiltRoots(
  dependencies: DesktopHelperResolutionDependencies,
  env: NodeJS.ProcessEnv,
): readonly string[] {
  return desktopHelperPrebuiltRoots(env, dependencies.prebuiltRoot);
}

async function defaultReadOsRelease(): Promise<string | undefined> {
  for (const path of ["/etc/os-release", "/usr/lib/os-release"]) {
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (text !== undefined) return text;
  }
  return undefined;
}

async function defaultExecutableExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function describeSystem(system: HostSystem): string {
  const version = system.osVersionId.trim();
  return `${system.osId || "an unidentified distribution"} ${version === "" ? "(rolling)" : version}, ${system.arch}`;
}

function describeBuild(build: DesktopHelperPrebuild): string {
  const version = build.osVersionId.trim();
  return `${build.osId}${version === "" ? "" : ` ${version}`} ${build.arch}${
    build.builtOn ? ` (built on ${build.builtOn})` : ""
  }`;
}

function versionParts(value: string): readonly number[] {
  return value.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

function same(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function unquote(value: string): string {
  const quoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")));
  return quoted ? value.slice(1, -1) : value;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
