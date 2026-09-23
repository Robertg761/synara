/**
 * The KWin installer script (native/computer-use-kwin/scripts/install-and-load.sh)
 * run for real under bash, in a sandbox whose cmake, busctl and kwin_wayland
 * are stubs: a fake KWin install tree stands in for /usr, and a stub session
 * bus stands in for the compositor's plugin interface.
 */
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createInstallScriptSandbox, type InstallScriptSandbox } from "./installScriptSandbox.ts";

const PLUGIN_SOURCE = join(import.meta.dirname, "..", "..", "native", "computer-use-kwin");
const PLUGIN_SOURCE_FILES = [
  "CMakeLists.txt",
  "metadata.json",
  "main.cpp",
  "synaracomputeruseplugin.h",
  "computeruseauth.h",
  "synaracomputeruseplugin.cpp",
  "synaracomputerusebuildinfo.h.in",
  "scripts/install-and-load.sh",
] as const;

/** Stub cmake and busctl, kept as shell files next to the plugin's other tests. */
const STUBS = join(PLUGIN_SOURCE, "tests", "install-script-stubs");

interface FakeKwinTree {
  readonly libraryRoot: string;
  readonly includeRoot: string;
}

describe("KWin install-and-load.sh", () => {
  let sandbox: InstallScriptSandbox;

  beforeEach(async () => {
    sandbox = await createInstallScriptSandbox();
    await sandbox.stub("cmake", await readFile(join(STUBS, "cmake"), "utf8"));
    await sandbox.stub("ninja", "exit 0");
    await sandbox.stub("busctl", await readFile(join(STUBS, "busctl"), "utf8"));
    // Aborts outside a real compositor start on some hosts (and dumps core):
    // the installer must never need it.
    await sandbox.stub("kwin_wayland", "exit 134");
  });

  afterEach(async () => {
    await sandbox.dispose();
  });

  /** A copy of the plugin sources, as an AppImage mounts them per launch. */
  async function sourceCopy(name: string): Promise<string> {
    const directory = join(sandbox.root, name);
    await Promise.all(
      PLUGIN_SOURCE_FILES.map((file) =>
        cp(join(PLUGIN_SOURCE, file), join(directory, file), { recursive: true }),
      ),
    );
    return directory;
  }

  async function fakeKwinTree(
    options: {
      dependencies?: readonly string[];
      headers?: readonly string[];
      libkwin?: boolean;
    } = {},
  ): Promise<FakeKwinTree> {
    const libraryRoot = join(sandbox.root, "sysroot", "usr", "lib");
    const includeRoot = join(sandbox.root, "sysroot", "usr", "include");
    const dependencies = options.dependencies ?? [
      "ECM",
      "Qt6Core",
      "Wayland",
      "epoxy",
      "Libdrm",
      "Vulkan",
    ];
    const headers = options.headers ?? [
      "xkbcommon/xkbcommon.h",
      "vulkan/vulkan.h",
      "epoxy/gl.h",
      "xf86drm.h",
      "wayland-server.h",
    ];
    await mkdir(join(libraryRoot, "cmake", "KWin"), { recursive: true });
    await writeFile(
      join(libraryRoot, "cmake", "KWin", "KWinConfig.cmake"),
      [
        "include(CMakeFindDependencyMacro)",
        ...dependencies.map((name) =>
          name === "Wayland"
            ? "find_dependency(Wayland REQUIRED Server)"
            : `find_dependency(${name})`,
        ),
        "",
      ].join("\n"),
    );
    await writeFile(
      join(libraryRoot, "cmake", "KWin", "KWinConfigVersion.cmake"),
      'set(PACKAGE_VERSION "6.7.4")\n',
    );
    await writeFile(join(libraryRoot, "libvulkan.so"), "");
    if (options.libkwin ?? true) {
      await writeFile(join(libraryRoot, "libkwin.so.6.7.4"), "");
      await symlink("libkwin.so.6.7.4", join(libraryRoot, "libkwin.so.6"));
    }
    for (const header of headers) {
      await mkdir(join(includeRoot, header, ".."), { recursive: true });
      await writeFile(join(includeRoot, header), "");
    }
    return { libraryRoot, includeRoot };
  }

  function scriptEnv(tree: FakeKwinTree): Record<string, string> {
    return {
      SYNARA_KWIN_LIBRARY_ROOTS: tree.libraryRoot,
      SYNARA_KWIN_INCLUDE_ROOTS: tree.includeRoot,
      SYNARA_KWIN_PLUGIN_DIR: join(sandbox.home, "plugins"),
    };
  }

  describe("build dependency check (R14)", () => {
    it("names a header KWin's cmake config needs before running cmake", async () => {
      const source = await sourceCopy("source");
      const tree = await fakeKwinTree({
        headers: ["xkbcommon/xkbcommon.h", "epoxy/gl.h", "xf86drm.h", "wayland-server.h"],
      });

      const result = sandbox.run(
        join(source, "scripts", "install-and-load.sh"),
        ["--build-only"],
        scriptEnv(tree),
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("vulkan/vulkan.h");
      expect(result.stderr).toContain("KWinConfig.cmake");
      expect((await sandbox.calls()).filter((call) => call.startsWith("cmake"))).toEqual([]);
    });

    it("only asks for Vulkan when this KWin's config depends on it", async () => {
      const source = await sourceCopy("source");
      const tree = await fakeKwinTree({
        dependencies: ["ECM", "Qt6Core", "Wayland", "epoxy", "Libdrm"],
        headers: ["xkbcommon/xkbcommon.h", "epoxy/gl.h", "xf86drm.h", "wayland-server.h"],
      });

      const result = sandbox.run(
        join(source, "scripts", "install-and-load.sh"),
        ["--build-only"],
        scriptEnv(tree),
      );

      expect(result.stderr).not.toContain("ERROR");
      expect(result.status).toBe(0);
      expect(result.stdout.trim().split("\n").at(-1)).toMatch(
        /\/build\/kwin\/plugins\/SynaraComputerUsePlugin\.so$/,
      );
    });
  });
});
