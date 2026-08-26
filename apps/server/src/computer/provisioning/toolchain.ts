/**
 * Whether this machine could compile a native helper, asked without compiling.
 *
 * `probeAvailability()` on both tiers has to answer "could a binary exist here"
 * cheaply and without side effects, because it runs at boot and on every render
 * of the settings card. The KWin tier already makes that call for cmake and the
 * KWin headers; this is the same question for the Tier 2 helper, whose build
 * needs far less: a C compiler, pkg-config, wayland-scanner, and two
 * development packages.
 *
 * Every check is a filesystem read or one short-lived `pkg-config --exists`.
 * Nothing here spawns a compiler or touches the user's desktop.
 */
import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** `pkg-config --exists` is fast, but not so fast that it may hang a probe. */
const PKG_CONFIG_TIMEOUT_MS = 5_000;

export async function executableExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Whether a bare command name resolves to something executable on `PATH`. */
export async function commandExists(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const directories = (env.PATH ?? "").split(":").filter((entry) => entry.length > 0);
  for (const directory of directories) {
    if (await executableExists(join(directory, command))) return true;
  }
  return false;
}

/**
 * Whether pkg-config can see every named module.
 *
 * Asked in one invocation because `pkg-config --exists a b` is already an
 * all-or-nothing question, and one process is one process.
 */
export async function pkgConfigHasModules(
  modules: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (modules.length === 0) return true;
  try {
    await execFileAsync("pkg-config", ["--exists", ...modules], {
      timeout: PKG_CONFIG_TIMEOUT_MS,
      env,
    });
    return true;
  } catch {
    return false;
  }
}

/** One missing piece of the toolchain, named the way a user can act on it. */
export interface ToolchainGap {
  readonly what: string;
  readonly install: string;
}

/**
 * What the desktop helper's `build.sh` requires, in the same order the script
 * checks it, so the two never disagree about what "buildable" means.
 */
export const DESKTOP_HELPER_TOOLCHAIN: readonly {
  readonly kind: "command" | "pkg-config";
  readonly name: string;
  readonly install: string;
}[] = [
  {
    kind: "command",
    name: "cc",
    install: "gcc or clang (pacman -S gcc / dnf install gcc / apt install build-essential)",
  },
  {
    kind: "command",
    name: "pkg-config",
    install:
      "pkgconf (pacman -S pkgconf / dnf install pkgconf-pkg-config / apt install pkg-config)",
  },
  {
    kind: "command",
    name: "wayland-scanner",
    install: "wayland (pacman -S wayland / dnf install wayland-devel / apt install libwayland-dev)",
  },
  {
    kind: "pkg-config",
    name: "wayland-client",
    install:
      "the libwayland development package (pacman -S wayland / dnf install wayland-devel / apt install libwayland-dev)",
  },
  {
    kind: "pkg-config",
    name: "xkbcommon",
    install:
      "the xkbcommon development package (pacman -S libxkbcommon / dnf install libxkbcommon-devel / apt install libxkbcommon-dev)",
  },
];

export interface ToolchainProbeDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly commandExists?: (command: string) => Promise<boolean>;
  readonly pkgConfigHasModules?: (modules: readonly string[]) => Promise<boolean>;
}

/**
 * Every requirement this machine is missing, empty when it can build.
 *
 * Returns the whole list rather than the first gap: a user without a toolchain
 * is usually missing several packages, and three refusals in a row — each
 * naming one more package — is the worst possible way to learn that.
 */
export async function desktopHelperToolchainGaps(
  dependencies: ToolchainProbeDependencies = {},
): Promise<readonly ToolchainGap[]> {
  const env = dependencies.env ?? process.env;
  const hasCommand = dependencies.commandExists ?? ((name: string) => commandExists(name, env));
  const hasModules =
    dependencies.pkgConfigHasModules ??
    ((names: readonly string[]) => pkgConfigHasModules(names, env));

  const gaps: ToolchainGap[] = [];
  for (const requirement of DESKTOP_HELPER_TOOLCHAIN) {
    if (requirement.kind === "command") {
      if (!(await hasCommand(requirement.name))) {
        gaps.push({ what: requirement.name, install: requirement.install });
      }
      continue;
    }
    // pkg-config itself missing already produced a gap; asking it anything now
    // would only add a second sentence about the same missing package.
    if (gaps.some((gap) => gap.what === "pkg-config")) continue;
    if (!(await hasModules([requirement.name]))) {
      gaps.push({ what: requirement.name, install: requirement.install });
    }
  }
  return gaps;
}

/** One sentence listing what to install, for a refusal or an availability card. */
export function describeToolchainGaps(gaps: readonly ToolchainGap[]): string {
  if (gaps.length === 0) return "";
  return `This machine is missing ${gaps.map((gap) => gap.what).join(", ")}. Install ${gaps
    .map((gap) => gap.install)
    .join("; ")}.`;
}
