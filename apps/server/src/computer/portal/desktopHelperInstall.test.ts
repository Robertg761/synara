import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  desktopHelperPath,
  glibcIsAvailable,
  parseOsRelease,
  readDesktopHelperManifest,
  resolveDesktopHelper,
  runtimeGlibcVersion,
  selectDesktopHelperPrebuild,
  type DesktopHelperPrebuild,
  type DesktopHelperResolutionDependencies,
} from "./desktopHelperInstall.ts";

const temp = (): Promise<string> => mkdtemp(join(tmpdir(), "synara-helper-"));

const FEDORA_OS_RELEASE = [
  'NAME="Fedora Linux"',
  "VERSION_ID=44",
  "ID=fedora",
  'PRETTY_NAME="Fedora Linux 44"',
  "",
].join("\n");

const ARCH_OS_RELEASE = ['NAME="Arch Linux"', "ID=arch", 'PRETTY_NAME="Arch Linux"', ""].join("\n");

const build = (overrides: Partial<DesktopHelperPrebuild> = {}): DesktopHelperPrebuild => ({
  osId: "fedora",
  osVersionId: "44",
  arch: "x64",
  file: "helper-fedora-44-x64",
  sha256: "00",
  ...overrides,
});

/**
 * A prebuilt root on disk with real bytes and a real checksum, because the
 * verification this module does is over the bytes that ship and a fake would be
 * testing the fake.
 */
async function prebuiltRoot(
  builds: readonly DesktopHelperPrebuild[],
  contents = "#!/bin/sh\nexit 0\n",
): Promise<string> {
  const root = join(await temp(), "prebuilt");
  await mkdir(root, { recursive: true });
  const written = await Promise.all(
    builds.map(async (entry) => {
      await writeFile(join(root, entry.file), contents);
      return {
        ...entry,
        sha256:
          entry.sha256 === "00"
            ? createHash("sha256").update(contents).digest("hex")
            : entry.sha256,
      };
    }),
  );
  await writeFile(join(root, "manifest.json"), JSON.stringify({ builds: written }, null, 2));
  return root;
}

/** A Fedora 44 x64 machine with nothing installed and nothing overridden. */
async function fedoraHost(
  overrides: Partial<DesktopHelperResolutionDependencies> = {},
): Promise<DesktopHelperResolutionDependencies> {
  const home = await temp();
  return {
    env: { HOME: home, XDG_DATA_HOME: join(home, ".local", "share") },
    readOsRelease: () => Promise.resolve(FEDORA_OS_RELEASE),
    arch: "x64",
    glibc: () => "2.42",
    ...overrides,
  };
}

describe("desktopHelperPath", () => {
  it("prefers the override, then XDG_DATA_HOME, then the home directory", () => {
    expect(desktopHelperPath({ SYNARA_COMPUTER_HELPER: " /opt/helper " })).toBe("/opt/helper");
    expect(desktopHelperPath({ XDG_DATA_HOME: "/data", HOME: "/home/tester" })).toBe(
      "/data/synara/computer/synara-computer-desktop-helper",
    );
    expect(desktopHelperPath({ HOME: "/home/tester" })).toBe(
      "/home/tester/.local/share/synara/computer/synara-computer-desktop-helper",
    );
  });
});

describe("parseOsRelease", () => {
  it("reads ID and VERSION_ID, quoted or not, and ignores everything else", () => {
    expect(parseOsRelease(FEDORA_OS_RELEASE)).toEqual({ osId: "fedora", osVersionId: "44" });
    expect(parseOsRelease('ID="opensuse-tumbleweed"\nVERSION_ID="20260817"')).toEqual({
      osId: "opensuse-tumbleweed",
      osVersionId: "20260817",
    });
    // Arch publishes no VERSION_ID at all, which is a fact about it rather than
    // a parse failure.
    expect(parseOsRelease(ARCH_OS_RELEASE)).toEqual({ osId: "arch", osVersionId: "" });
    expect(parseOsRelease("")).toEqual({ osId: "", osVersionId: "" });
  });
});

describe("selectDesktopHelperPrebuild", () => {
  const system = { osId: "fedora", osVersionId: "44", arch: "x64", glibc: "2.42" };

  it("matches the exact distribution, version, and architecture", () => {
    const manifest = { builds: [build()] };

    expect(selectDesktopHelperPrebuild(manifest, system)).toEqual(build());
    // A near miss is a miss: the binary links that system's libwayland and
    // glibc, and a wrong one fails at execve with a message about a .so.
    expect(selectDesktopHelperPrebuild(manifest, { ...system, osVersionId: "43" })).toBeUndefined();
    expect(selectDesktopHelperPrebuild(manifest, { ...system, osId: "rhel" })).toBeUndefined();
    expect(selectDesktopHelperPrebuild(manifest, { ...system, arch: "arm64" })).toBeUndefined();
  });

  it("treats an empty version as a rolling distribution: this ID, any version", () => {
    const manifest = {
      builds: [build({ osId: "arch", osVersionId: "", file: "helper-arch-x64" })],
    };

    // Arch has no version at all, Tumbleweed has a snapshot date no machine
    // will ever equal; both have to match on the ID alone or never match.
    expect(
      selectDesktopHelperPrebuild(manifest, { osId: "arch", osVersionId: "", arch: "x64" }),
    ).toBeDefined();
    expect(
      selectDesktopHelperPrebuild(manifest, { osId: "arch", osVersionId: "20260817", arch: "x64" }),
    ).toBeDefined();
    expect(
      selectDesktopHelperPrebuild(manifest, { osId: "fedora", osVersionId: "", arch: "x64" }),
    ).toBeUndefined();
  });

  it("skips a build that needs a newer glibc than this machine has", () => {
    const manifest = { builds: [build({ osId: "arch", osVersionId: "", glibc: "2.42" })] };
    const arch = { osId: "arch", osVersionId: "", arch: "x64" };

    // glibc is backwards compatible and not forwards, so this is the one
    // direction that fails, and on a rolling entry it is the only guard there is.
    expect(selectDesktopHelperPrebuild(manifest, { ...arch, glibc: "2.41" })).toBeUndefined();
    expect(selectDesktopHelperPrebuild(manifest, { ...arch, glibc: "2.42" })).toBeDefined();
    expect(selectDesktopHelperPrebuild(manifest, { ...arch, glibc: "2.43" })).toBeDefined();
    // An unreadable host glibc is no constraint rather than a refusal: the
    // os-release ID already carried the system's identity.
    expect(selectDesktopHelperPrebuild(manifest, arch)).toBeDefined();
  });
});

describe("glibcIsAvailable", () => {
  it("compares numerically rather than as text", () => {
    expect(glibcIsAvailable("2.9", "2.10")).toBe(true);
    expect(glibcIsAvailable("2.10", "2.9")).toBe(false);
    expect(glibcIsAvailable("2.42", "2.42.1")).toBe(true);
    expect(glibcIsAvailable(undefined, "2.42")).toBe(true);
  });
});

describe("runtimeGlibcVersion", () => {
  it("answers a version or nothing, and never throws", () => {
    const version = runtimeGlibcVersion();
    expect(version === undefined || /^[0-9]+(\.[0-9]+)+$/.test(version)).toBe(true);
  });
});

describe("readDesktopHelperManifest", () => {
  it("is undefined for a missing or unparseable manifest", async () => {
    const dir = await temp();
    expect(await readDesktopHelperManifest(join(dir, "manifest.json"))).toBeUndefined();
    await writeFile(join(dir, "manifest.json"), "{ not json");
    expect(await readDesktopHelperManifest(join(dir, "manifest.json"))).toBeUndefined();
  });

  it("drops entries that could not be installed anyway, including path escapes", async () => {
    const dir = await temp();
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({
        builds: [
          { osId: "fedora", arch: "x64", file: "../../etc/passwd", sha256: "aa" },
          { osId: "fedora", arch: "x64", sha256: "aa" },
          { osId: "fedora", arch: "x64", file: "good", sha256: "aa" },
        ],
      }),
    );

    const manifest = await readDesktopHelperManifest(join(dir, "manifest.json"));
    expect(manifest?.builds).toEqual([
      { osId: "fedora", osVersionId: "", arch: "x64", file: "good", sha256: "aa" },
    ]);
  });
});

describe("resolveDesktopHelper", () => {
  it("uses SYNARA_COMPUTER_HELPER before anything else", async () => {
    const deps = await fedoraHost({
      env: { SYNARA_COMPUTER_HELPER: "/opt/synara/helper" },
      executableExists: (path) => Promise.resolve(path === "/opt/synara/helper"),
      prebuiltRoot: await prebuiltRoot([build()]),
    });

    expect(await resolveDesktopHelper(deps)).toEqual({
      path: "/opt/synara/helper",
      source: "override",
    });
  });

  it("never installs over an override, and says that is why", async () => {
    const deps = await fedoraHost({
      env: { SYNARA_COMPUTER_HELPER: "/opt/synara/helper" },
      executableExists: () => Promise.resolve(false),
      prebuiltRoot: await prebuiltRoot([build()]),
    });
    const resolution = await resolveDesktopHelper(deps);

    // An operator who named a path named the answer; installing a different
    // binary elsewhere would leave that path still pointing at nothing.
    expect(resolution.path).toBeUndefined();
    expect(resolution.note).toContain("SYNARA_COMPUTER_HELPER points at this path");
  });

  it("uses a helper build.sh already installed without reading the manifest at all", async () => {
    const deps = await fedoraHost({
      executableExists: () => Promise.resolve(true),
      prebuiltRoot: join(await temp(), "does-not-exist"),
    });
    const resolution = await resolveDesktopHelper(deps);

    expect(resolution.source).toBe("installed");
    expect(resolution.path).toBe(desktopHelperPath(deps.env));
  });

  it("installs a matching shipped binary, executable, where the probe looks", async () => {
    const deps = await fedoraHost({ prebuiltRoot: await prebuiltRoot([build()]) });
    const destination = desktopHelperPath(deps.env);

    const resolution = await resolveDesktopHelper(deps);

    expect(resolution).toEqual({ path: destination, source: "prebuilt" });
    expect(await readFile(destination, "utf8")).toBe("#!/bin/sh\nexit 0\n");
    expect((await stat(destination)).mode & 0o777).toBe(0o755);
    // And nothing is left behind by the staged copy the rename went through.
    expect(
      await readFile(`${destination}.${process.pid}.partial`, "utf8").catch(() => "gone"),
    ).toBe("gone");
  });

  it("refuses a shipped binary whose bytes do not match the manifest", async () => {
    const root = await prebuiltRoot([build({ sha256: "not-the-checksum" })]);
    const deps = await fedoraHost({ prebuiltRoot: root });
    const resolution = await resolveDesktopHelper(deps);

    // Not installed and not silently skipped: a checksum failure means the file
    // that shipped is not the file that was built.
    expect(resolution.path).toBeUndefined();
    expect(resolution.note).toContain("failed its checksum");
    expect(resolution.note).toContain("fedora 44 x64");
    expect(await readFile(desktopHelperPath(deps.env), "utf8").catch(() => "absent")).toBe(
      "absent",
    );
  });

  it("names this system when the shipped binaries were built for other ones", async () => {
    const deps = await fedoraHost({
      readOsRelease: () => Promise.resolve(ARCH_OS_RELEASE),
      prebuiltRoot: await prebuiltRoot([build(), build({ osVersionId: "43", file: "f43" })]),
    });
    const resolution = await resolveDesktopHelper(deps);

    expect(resolution.path).toBeUndefined();
    expect(resolution.note).toContain("None of the 2 helper binaries");
    expect(resolution.note).toContain("arch (rolling), x64");
  });

  it("says there was nothing to install when this build ships no binaries", async () => {
    const deps = await fedoraHost({ prebuiltRoot: join(await temp(), "absent") });
    const resolution = await resolveDesktopHelper(deps);

    expect(resolution.note).toBe(
      "No prebuilt helpers ship with this build, so there was nothing to install.",
    );
  });

  // root ignores the directory mode this leans on, so the case it describes
  // cannot be staged there.
  it.skipIf(process.getuid?.() === 0)(
    "reports an install it could not perform rather than throwing",
    async () => {
      const home = await temp();
      // The directory the helper would go in, made unwritable: an install that
      // cannot happen is a sentence, because the probe above this never throws.
      const target = join(home, "synara", "computer");
      await mkdir(target, { recursive: true });
      await chmod(target, 0o500);
      const deps = await fedoraHost({
        env: { HOME: home, XDG_DATA_HOME: home },
        prebuiltRoot: await prebuiltRoot([build()]),
      });

      const resolution = await resolveDesktopHelper(deps);
      await chmod(target, 0o700);

      expect(resolution.path).toBeUndefined();
      expect(resolution.note).toContain("could not be installed at");
    },
  );
});
