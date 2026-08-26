/**
 * The Tier 2 half of "install the update, turn it on, and it works".
 *
 * Every case here is driven through a temporary HOME, so nothing touches the
 * developer's own `~/.local/share/synara/computer` and no test can be made to
 * pass by a helper that happens to be installed on the machine running it.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  desktopHelperCouldExist,
  DesktopHelperProvisionError,
  locateHelperSources,
  provisionDesktopHelper,
} from "./desktopHelperProvisioning.ts";
import { installStampPath, readInstallStamp } from "./installStamp.ts";

let home: string;
let sources: string;

/** A stand-in for `native/computer-desktop-helper`, hashed like the real one. */
async function writeSources(body: string): Promise<void> {
  await mkdir(join(sources, "src"), { recursive: true });
  await writeFile(join(sources, "build.sh"), "#!/usr/bin/env bash\ntrue\n");
  await writeFile(join(sources, "src", "helper.c"), body);
}

async function writePrebuilt(root: string, contents: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const file = "synara-computer-desktop-helper-test";
  await writeFile(join(root, file), contents);
  await chmod(join(root, file), 0o755);
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      builds: [
        {
          osId: "testos",
          osVersionId: "",
          arch: process.arch,
          file,
          sha256: createHash("sha256").update(contents).digest("hex"),
        },
      ],
    }),
  );
}

const OS_RELEASE = 'ID=testos\nVERSION_ID=""\n';

function deps(overrides: Record<string, unknown> = {}) {
  return {
    env: { HOME: home, XDG_DATA_HOME: join(home, ".local", "share") } as NodeJS.ProcessEnv,
    sourceDirectory: sources,
    // The real one shells out to pkg-config; every test that cares drives it.
    commandExists: () => Promise.resolve(true),
    pkgConfigHasModules: () => Promise.resolve(true),
    ...overrides,
  };
}

function helperPath(): string {
  return join(home, ".local", "share", "synara", "computer", "synara-computer-desktop-helper");
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "synara-helper-home-"));
  sources = await mkdtemp(join(tmpdir(), "synara-helper-src-"));
  await writeSources("int main(void) { return 0; }\n");
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(sources, { recursive: true, force: true });
});

describe("provisionDesktopHelper", () => {
  it("compiles from source when this build ships no binary for the system", async () => {
    // The case every Linux user is in today: Synara runs from a checkout, no
    // release has ever unpacked the prebuild workflow's artifacts, and before
    // this existed there was no path from here to a working helper at all.
    let built: string | undefined;
    const result = await provisionDesktopHelper(
      deps({
        prebuiltRoot: undefined,
        buildFromSource: async (directory: string) => {
          built = directory;
          const path = helperPath();
          await mkdir(join(home, ".local", "share", "synara", "computer"), { recursive: true });
          await writeFile(path, "#!/bin/sh\ntrue\n");
          await chmod(path, 0o755);
          return path;
        },
      }),
    );

    expect(built).toBe(sources);
    expect(result.action).toBe("installed-from-source");
    expect(result.path).toBe(helperPath());
  });

  it("prefers a shipped binary over compiling one", async () => {
    const prebuiltRoot = join(sources, "prebuilt");
    await writePrebuilt(prebuiltRoot, "shipped-helper");

    const result = await provisionDesktopHelper(
      deps({
        prebuiltRoot,
        readOsRelease: () => Promise.resolve(OS_RELEASE),
        buildFromSource: () => Promise.reject(new Error("must not compile")),
      }),
    );

    expect(result.action).toBe("installed-prebuilt");
    await expect(readFile(helperPath(), "utf8")).resolves.toBe("shipped-helper");
  });

  it("does not reinstall when the installed helper matches this build", async () => {
    const install = async () => {
      const path = helperPath();
      await mkdir(join(home, ".local", "share", "synara", "computer"), { recursive: true });
      await writeFile(path, "#!/bin/sh\ntrue\n");
      await chmod(path, 0o755);
      return path;
    };
    await provisionDesktopHelper(deps({ prebuiltRoot: undefined, buildFromSource: install }));

    const again = await provisionDesktopHelper(
      deps({
        prebuiltRoot: undefined,
        buildFromSource: () => Promise.reject(new Error("must not compile twice")),
      }),
    );
    expect(again.action).toBe("already-current");
  });

  it("recompiles when an update changed the helper's sources", async () => {
    // The whole reason the stamp exists. The helper reports no version of its
    // own, so without this an upgraded Synara keeps running the binary the
    // previous release compiled, forever.
    const install = async () => {
      const path = helperPath();
      await mkdir(join(home, ".local", "share", "synara", "computer"), { recursive: true });
      await writeFile(path, "#!/bin/sh\ntrue\n");
      await chmod(path, 0o755);
      return path;
    };
    await provisionDesktopHelper(deps({ prebuiltRoot: undefined, buildFromSource: install }));

    await writeSources("int main(void) { return 1; /* the update */ }\n");
    let recompiled = false;
    const result = await provisionDesktopHelper(
      deps({
        prebuiltRoot: undefined,
        buildFromSource: async () => {
          recompiled = true;
          return await install();
        },
      }),
    );

    expect(recompiled).toBe(true);
    expect(result.action).toBe("installed-from-source");
  });

  it("leaves a helper the user built by hand alone", async () => {
    // An unstamped binary is one `build.sh` put there, and replacing a build
    // somebody made deliberately is not provisioning's call.
    const path = helperPath();
    await mkdir(join(home, ".local", "share", "synara", "computer"), { recursive: true });
    await writeFile(path, "#!/bin/sh\ntrue\n");
    await chmod(path, 0o755);

    const result = await provisionDesktopHelper(
      deps({
        prebuiltRoot: undefined,
        buildFromSource: () => Promise.reject(new Error("must not replace a hand build")),
      }),
    );
    expect(result.action).toBe("already-current");
  });

  it("names every missing package rather than failing one at a time", async () => {
    // Three refusals in a row, each naming one more package, is the worst way
    // to learn a toolchain is missing.
    const error = await provisionDesktopHelper(
      deps({
        prebuiltRoot: undefined,
        commandExists: (name: string) => Promise.resolve(name !== "cc"),
        pkgConfigHasModules: () => Promise.resolve(false),
        buildFromSource: () => Promise.reject(new Error("must not compile")),
      }),
    ).then(
      () => {
        throw new Error("provisioning should have refused");
      },
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(DesktopHelperProvisionError);
    const message = (error as Error).message;
    expect(message).toContain("cc");
    expect(message).toContain("wayland-client");
    expect(message).toContain("xkbcommon");
  });

  it("refuses to install over a helper the operator named", async () => {
    const override = join(home, "nothing-here");
    await expect(
      provisionDesktopHelper(
        deps({
          env: { HOME: home, SYNARA_COMPUTER_HELPER: override } as NodeJS.ProcessEnv,
          buildFromSource: () => Promise.reject(new Error("must not compile")),
        }),
      ),
    ).rejects.toThrow(/SYNARA_COMPUTER_HELPER/);
  });

  it("records how the installed helper got there", async () => {
    await provisionDesktopHelper(
      deps({
        prebuiltRoot: undefined,
        buildFromSource: async () => {
          const path = helperPath();
          await mkdir(join(home, ".local", "share", "synara", "computer"), { recursive: true });
          await writeFile(path, "#!/bin/sh\ntrue\n");
          await chmod(path, 0o755);
          return path;
        },
      }),
    );

    const stamp = await readInstallStamp(installStampPath(helperPath()));
    expect(stamp?.source).toBe("built from source");
    expect(stamp?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("desktopHelperCouldExist", () => {
  it("says yes when the machine has the toolchain, before anything is built", async () => {
    // `probeAvailability()` leans on this, and a "no" here is self-fulfilling:
    // it withholds the computer tools, so nothing ever reaches the establishing
    // read that would have compiled the helper.
    await expect(desktopHelperCouldExist(deps({ prebuiltRoot: undefined }))).resolves.toBe(true);
  });

  it("says no when there is no binary, no sources, and no compiler", async () => {
    await expect(
      desktopHelperCouldExist(
        deps({
          prebuiltRoot: undefined,
          sourceDirectory: undefined,
          commandExists: () => Promise.resolve(false),
        }),
      ),
    ).resolves.toBe(false);
  });
});

describe("locateHelperSources", () => {
  it("prefers an explicitly configured checkout", () => {
    expect(
      locateHelperSources({ SYNARA_COMPUTER_HELPER_SOURCE_DIR: sources } as NodeJS.ProcessEnv),
    ).toBe(sources);
  });

  it("finds the sources that ship in this repository", () => {
    // Guards the packaged-or-checkout fallback: if this returns undefined, a
    // from-source install has nothing to compile and provisioning refuses.
    expect(locateHelperSources({} as NodeJS.ProcessEnv)).toBeDefined();
  });
});
