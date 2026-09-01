/**
 * Where the macOS computer-use helper lives, in every build shape.
 *
 * Four independent callers need the same answer and previously each spelled it
 * out by hand: the desktop main process (both to tell its backend child where
 * the helper is and to run the permission preflight itself), the packaging
 * config that stages and signs the bundle, and the build script that produces
 * it. A rename in one place left the others pointing at a path that no longer
 * existed — and because a missing helper degrades silently to "no computer
 * control", nothing failed at build time. One derivation, one bundle name.
 *
 * The paths are macOS-only. Nothing here should be joined onto a Windows or
 * Linux install root; `COMPUTER_HELPER_BINARY_PATH_ENV` is likewise only set by
 * a packaged darwin build.
 *
 * @module computerHelperPaths
 */
import computerHelperBundle from "./computerHelperBundle.json" with { type: "json" };

/** The helper executable's file name, inside the bundle and in dev builds. */
export const COMPUTER_HELPER_BINARY_NAME = computerHelperBundle.binaryName;

/**
 * The helper's app bundle. It is a bundle, not a loose binary, because macOS
 * attributes TCC grants to a bundle identity: this is what the user sees and
 * approves in Privacy & Security.
 */
export const COMPUTER_HELPER_BUNDLE_NAME = computerHelperBundle.bundleName;

/** Path of the executable within its own bundle. */
export const COMPUTER_HELPER_BUNDLE_EXECUTABLE_SEGMENTS = [
  "Contents",
  "MacOS",
  COMPUTER_HELPER_BINARY_NAME,
] as const;

/** Where the packaged bundle sits inside `Synara.app`. */
export const COMPUTER_HELPER_PACKAGED_SEGMENTS = [
  "Contents",
  "Helpers",
  COMPUTER_HELPER_BUNDLE_NAME,
] as const;

/**
 * The bundle a development build writes, relative to the repository root.
 * `apps/desktop/scripts/build-computer-helper.mjs` writes here by default.
 */
export const COMPUTER_HELPER_DEV_BUNDLE_SEGMENTS = [
  "apps",
  "desktop",
  ".electron-runtime",
  "computer-use",
  COMPUTER_HELPER_BUNDLE_NAME,
] as const;

/**
 * The loose binary `apps/server/native/computer-use-macos/build.sh` writes,
 * relative to the repository root. A developer who ran the Swift build directly
 * gets a working helper without the bundle wrapper.
 */
export const COMPUTER_HELPER_DEV_RAW_SEGMENTS = [
  "apps",
  "server",
  "native",
  "computer-use-macos",
  "build",
  COMPUTER_HELPER_BINARY_NAME,
] as const;

/** Signed macOS computer-use helper embedded by the desktop release build. */
export const COMPUTER_HELPER_BINARY_PATH_ENV = "SYNARA_COMPUTER_HELPER_BINARY_PATH";

/**
 * Joins segments with `/`. The packaging config and the electron-builder globs
 * are POSIX-shaped regardless of host, and these paths only ever describe a
 * macOS bundle, so a platform-aware join would be wrong here.
 */
function posixJoin(...segments: readonly string[]): string {
  return segments.join("/");
}

/** `Contents/Helpers/Synara Computer Use.app`, for electron-builder. */
export const COMPUTER_HELPER_PACKAGED_BUNDLE_PATH = posixJoin(...COMPUTER_HELPER_PACKAGED_SEGMENTS);

/** `Contents/Helpers/Synara Computer Use.app/Contents/MacOS/synara-computer-helper`. */
export const COMPUTER_HELPER_PACKAGED_EXECUTABLE_PATH = posixJoin(
  ...COMPUTER_HELPER_PACKAGED_SEGMENTS,
  ...COMPUTER_HELPER_BUNDLE_EXECUTABLE_SEGMENTS,
);

/** `apps/desktop/.electron-runtime/computer-use/Synara Computer Use.app`. */
export const COMPUTER_HELPER_DEV_BUNDLE_PATH = posixJoin(...COMPUTER_HELPER_DEV_BUNDLE_SEGMENTS);
