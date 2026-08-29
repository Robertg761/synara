import { describe, expect, it } from "vitest";

import {
  MacComputerHelperProvisioner,
  MacHelperBuildError,
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
}): Harness {
  const runCalls: { command: string; args: readonly string[] }[] = [];
  const existing = options.existing ?? new Set<string>();
  const provisioner = new MacComputerHelperProvisioner({
    helperSourceDir: "/repo/native/computer-use-macos",
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
  it("reports the toolchain present when xcodebuild answers", async () => {
    const { provisioner } = harness({});
    expect(await provisioner.xcodeToolchainPresent()).toBe(true);
  });

  it("reports the toolchain absent when xcodebuild cannot run", async () => {
    const { provisioner } = harness({ xcode: { code: 127, stdout: "", stderr: "not found" } });
    expect(await provisioner.xcodeToolchainPresent()).toBe(false);
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
});
