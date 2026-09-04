import { describe, expect, it } from "vitest";

import {
  isArchivedHelperSourceDir,
  MacComputerHelperProvisioner,
  MacHelperBuildError,
  resolveComputerHelperSourceDir,
  type ProcessRunResult,
} from "./macComputerHelperProvisioning.ts";

const XCODE: ProcessRunResult = {
  code: 0,
  stdout: "Xcode 26.2\nBuild version 17C52\n",
  stderr: "",
};

interface Harness {
  readonly runCalls: { command: string; args: readonly string[] }[];
  readonly provisioner: MacComputerHelperProvisioner;
  readonly existing: Set<string>;
}

function harness(options: {
  readonly xcode?: ProcessRunResult;
  readonly build?: ProcessRunResult;
  readonly existing?: Set<string>;
  readonly bundledBinaryPath?: string;
  readonly helperSourceDir?: string;
}): Harness {
  const runCalls: { command: string; args: readonly string[] }[] = [];
  const existing = options.existing ?? new Set<string>();
  const provisioner = new MacComputerHelperProvisioner({
    helperSourceDir: options.helperSourceDir ?? "/repo/native/computer-use-macos",
    ...(options.bundledBinaryPath ? { bundledBinaryPath: options.bundledBinaryPath } : {}),
    helperCacheRoot: "/cache",
    run: async (command, args) => {
      runCalls.push({ command, args });
      if (command === "xcodebuild") return options.xcode ?? XCODE;
      if (command === "/bin/sh") {
        const build = options.build ?? { code: 0, stdout: "", stderr: "" };
        // A successful build writes the binary into the output directory.
        if (build.code === 0) existing.add(`${args[1]}/synara-computer-helper`);
        return build;
      }
      throw new Error(`unexpected command ${command}`);
    },
    fileExists: async (candidate) => existing.has(candidate),
    readSources: async () => ["main.swift"],
    readSourceFile: async () => "source",
  });
  return { runCalls, provisioner, existing };
}

describe("MacComputerHelperProvisioner", () => {
  it("prefers the signed helper bundled with Synara without probing Xcode", async () => {
    const bundledBinaryPath = "/Applications/Synara.app/Contents/Helpers/synara-computer-helper";
    const { provisioner, runCalls } = harness({
      bundledBinaryPath,
      existing: new Set([bundledBinaryPath]),
      xcode: { code: 127, stdout: "", stderr: "not found" },
    });
    await expect(provisioner.ensureBinary()).resolves.toBe(bundledBinaryPath);
    expect(runCalls).toEqual([]);
  });

  it("reports the toolchain present when xcodebuild answers", async () => {
    const { provisioner } = harness({});
    expect(await provisioner.xcodeToolchainPresent()).toBe(true);
  });

  it("reports the toolchain absent when xcodebuild cannot run", async () => {
    const { provisioner } = harness({ xcode: { code: 127, stdout: "", stderr: "not found" } });
    expect(await provisioner.xcodeToolchainPresent()).toBe(false);
  });

  it("retries xcodebuild after a failed read instead of remembering the failure", async () => {
    // A timeout or a first-run license prompt must not convince the backend
    // that the machine has no Xcode until the server restarts.
    const runCalls: string[] = [];
    let failing = true;
    const provisioner = new MacComputerHelperProvisioner({
      helperSourceDir: "/repo/native/computer-use-macos",
      helperCacheRoot: "/cache",
      run: async (command) => {
        runCalls.push(command);
        if (failing) throw new Error("xcodebuild timed out");
        return XCODE;
      },
      fileExists: async () => false,
      readSources: async () => ["main.swift"],
      readSourceFile: async () => "source",
    });

    expect(await provisioner.xcodeToolchainPresent()).toBe(false);
    failing = false;
    expect(await provisioner.xcodeToolchainPresent()).toBe(true);
    expect(runCalls).toEqual(["xcodebuild", "xcodebuild"]);
  });

  it("retries xcodebuild when it exits non-zero or answers with nothing", async () => {
    const answers: ProcessRunResult[] = [
      { code: 69, stdout: "", stderr: "agreeing to the license requires admin privileges" },
      { code: 0, stdout: "  \n", stderr: "" },
      XCODE,
    ];
    const runCalls: string[] = [];
    const provisioner = new MacComputerHelperProvisioner({
      helperSourceDir: "/repo/native/computer-use-macos",
      helperCacheRoot: "/cache",
      run: async (command) => {
        runCalls.push(command);
        return answers.shift() ?? XCODE;
      },
      fileExists: async () => false,
      readSources: async () => ["main.swift"],
      readSourceFile: async () => "source",
    });

    expect(await provisioner.xcodeToolchainPresent()).toBe(false);
    expect(await provisioner.xcodeToolchainPresent()).toBe(false);
    expect(await provisioner.xcodeToolchainPresent()).toBe(true);
    expect(runCalls).toEqual(["xcodebuild", "xcodebuild", "xcodebuild"]);
  });

  it("memoizes a successful xcodebuild read", async () => {
    const { provisioner, runCalls } = harness({});
    expect(await provisioner.xcodeToolchainPresent()).toBe(true);
    expect(await provisioner.xcodeToolchainPresent()).toBe(true);
    expect(runCalls.filter((call) => call.command === "xcodebuild")).toHaveLength(1);
  });

  it("shares one failing xcodebuild spawn between concurrent callers, then retries", async () => {
    const runCalls: string[] = [];
    let failing = true;
    let release: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provisioner = new MacComputerHelperProvisioner({
      helperSourceDir: "/repo/native/computer-use-macos",
      helperCacheRoot: "/cache",
      run: async (command) => {
        runCalls.push(command);
        if (!failing) return XCODE;
        // Held open until both callers have asked, so the test observes the
        // in-flight read being shared rather than two serialized spawns.
        await started;
        throw new Error("xcodebuild timed out");
      },
      fileExists: async () => false,
      readSources: async () => ["main.swift"],
      readSourceFile: async () => "source",
    });

    const first = provisioner.xcodeToolchainPresent();
    const second = provisioner.xcodeToolchainPresent();
    release?.();
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(runCalls).toEqual(["xcodebuild"]);

    failing = false;
    expect(await provisioner.xcodeToolchainPresent()).toBe(true);
    expect(runCalls).toEqual(["xcodebuild", "xcodebuild"]);
  });

  it("returns a cached binary without building a second time", async () => {
    // First build populates the cache; the source digest is folded into the key
    // by the provisioner itself, so the test never has to reproduce the hash.
    const shared = harness({});
    const first = await shared.provisioner.ensureBinary();

    // A fresh provisioner over the same cache must find that binary and never
    // shell out to the build script.
    const second = harness({ existing: shared.existing });
    const binary = await second.provisioner.ensureBinary();
    expect(binary).toBe(first);
    expect(second.runCalls.some((call) => call.command === "/bin/sh")).toBe(false);
  });

  it("builds the helper when nothing is cached, then returns the produced binary", async () => {
    const { provisioner, runCalls } = harness({ build: { code: 0, stdout: "", stderr: "" } });
    const binary = await provisioner.ensureBinary();
    expect(binary.endsWith("/synara-computer-helper")).toBe(true);
    expect(runCalls.some((call) => call.command === "/bin/sh")).toBe(true);
  });

  it("throws an actionable build error when the compile fails", async () => {
    const { provisioner } = harness({
      build: { code: 1, stdout: "", stderr: "error: SimulatorKit not found" },
    });
    await expect(provisioner.ensureBinary()).rejects.toBeInstanceOf(MacHelperBuildError);
  });

  it("throws when the Xcode version cannot be determined", async () => {
    const { provisioner } = harness({ xcode: { code: 127, stdout: "", stderr: "" } });
    await expect(provisioner.ensureBinary()).rejects.toBeInstanceOf(MacHelperBuildError);
  });

  it("refuses to compile from inside the packaged app archive", async () => {
    // `app.asar` is one file that `stat` walks into and a compiler cannot read,
    // so attempting the build spends minutes to fail with a Swift error about a
    // missing file — the least informative way to say "no source fallback here".
    const { provisioner, runCalls } = harness({
      helperSourceDir:
        "/Applications/Synara.app/Contents/Resources/app.asar/dist/computer-use-macos",
    });
    await expect(provisioner.ensureBinary()).rejects.toThrow(
      /this build ships a prebuilt helper; the source fallback is unavailable/,
    );
    expect(runCalls.some((call) => call.command === "/bin/sh")).toBe(false);
  });

  it("recognizes an archived source path without being fooled by a similar name", () => {
    expect(
      isArchivedHelperSourceDir("/Applications/Synara.app/Contents/Resources/app.asar/dist"),
    ).toBe(true);
    // A directory merely *named* like the archive is a real, readable directory.
    expect(isArchivedHelperSourceDir("/repo/app.asar.unpacked/computer-use-macos")).toBe(false);
    expect(isArchivedHelperSourceDir("/repo/native/computer-use-macos")).toBe(false);
  });

  it("resolves the staged sources beside a bundled server before the source tree", () => {
    // One env-variable name, imported from the shared module the packaging
    // config and the desktop main process also read.
    const configured = resolveComputerHelperSourceDir(
      "/repo/apps/server/dist",
      (candidate) => candidate === "/elsewhere/computer-use-macos",
      "/elsewhere/computer-use-macos",
    );
    expect(configured).toBe("/elsewhere/computer-use-macos");

    const bundled = resolveComputerHelperSourceDir(
      "/repo/apps/server/dist",
      (candidate) => candidate === "/repo/apps/server/dist/computer-use-macos",
      undefined,
    );
    expect(bundled).toBe("/repo/apps/server/dist/computer-use-macos");

    const development = resolveComputerHelperSourceDir(
      "/repo/apps/server/src/computer",
      () => false,
      undefined,
    );
    expect(development).toBe("/repo/apps/server/native/computer-use-macos");
  });
});
