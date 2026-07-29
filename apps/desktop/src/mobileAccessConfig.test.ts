import FS from "node:fs";
import OS from "node:os";
import Path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MOBILE_ACCESS_CONFIG_FILE_MODE,
  gateMobileAccessConfig,
  isMobileAccessConfigInput,
  isMobileAccessMode,
  mobileAccessBackendEnv,
  readMobileAccessConfig,
  resolveDesktopBackendHost,
  resolveMobileAccessConfigPath,
  writeMobileAccessConfig,
} from "./mobileAccessConfig";

let userDataDir: string;
let configPath: string;

beforeEach(() => {
  userDataDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-mobile-access-"));
  configPath = resolveMobileAccessConfigPath(userDataDir);
});

afterEach(() => {
  FS.rmSync(userDataDir, { force: true, recursive: true });
});

describe("mobile access config persistence", () => {
  it("names the config file under the user data directory", () => {
    expect(configPath).toBe(Path.join(userDataDir, "mobile-access.json"));
  });

  it("falls back to a disabled loopback policy when nothing is stored", () => {
    expect(readMobileAccessConfig(configPath)).toEqual({
      enabled: false,
      mode: "trusted-proxy",
      approvedRoots: [],
    });
  });

  it("round-trips a stored policy and writes it 0600", () => {
    const written = writeMobileAccessConfig(
      configPath,
      {
        enabled: true,
        mode: "trusted-proxy",
        publicBaseUrl: "https://mac.tail1234.ts.net",
        approvedRoots: ["/Users/owner/code"],
      },
      { privateLanAvailable: false },
    );

    expect(written.enabled).toBe(true);
    expect(readMobileAccessConfig(configPath)).toEqual(written);
    expect(FS.statSync(configPath).mode & 0o777).toBe(MOBILE_ACCESS_CONFIG_FILE_MODE);
  });

  it("narrows the permissions of a pre-existing world-readable config", () => {
    FS.writeFileSync(configPath, "{}", { encoding: "utf8", mode: 0o644 });
    writeMobileAccessConfig(
      configPath,
      { enabled: false, mode: "trusted-proxy", approvedRoots: [] },
      { privateLanAvailable: false },
    );

    expect(FS.statSync(configPath).mode & 0o777).toBe(MOBILE_ACCESS_CONFIG_FILE_MODE);
  });

  it("ignores an unreadable or malformed config instead of throwing", () => {
    FS.writeFileSync(configPath, "not json at all", "utf8");

    expect(readMobileAccessConfig(configPath)).toEqual({
      enabled: false,
      mode: "trusted-proxy",
      approvedRoots: [],
    });
  });
});

describe("mobile access mode gating", () => {
  const privateLan = {
    enabled: true,
    mode: "private-lan" as const,
    privateBindAddress: "192.168.1.24",
    approvedRoots: ["/Users/owner/code"],
  };

  it("keeps private-lan in a development build", () => {
    expect(gateMobileAccessConfig(privateLan, { privateLanAvailable: true })).toEqual(privateLan);
  });

  it("uses the private interface for the desktop backend URL in development", () => {
    expect(
      resolveDesktopBackendHost(privateLan, { privateLanAvailable: true }),
    ).toBe("192.168.1.24");
    expect(
      resolveDesktopBackendHost(privateLan, { privateLanAvailable: false }),
    ).toBe("127.0.0.1");
    expect(
      resolveDesktopBackendHost(
        { ...privateLan, enabled: false },
        { privateLanAvailable: true },
      ),
    ).toBe("127.0.0.1");
  });

  it("strips the private bind and disables access in a packaged build", () => {
    const gated = gateMobileAccessConfig(privateLan, { privateLanAvailable: false });

    expect(gated).toEqual({
      enabled: false,
      mode: "trusted-proxy",
      approvedRoots: ["/Users/owner/code"],
    });
    expect(gated).not.toHaveProperty("privateBindAddress");
  });

  it("gates on write, so a hand-edited private-lan config cannot survive a save", () => {
    writeMobileAccessConfig(configPath, privateLan, { privateLanAvailable: false });

    const stored = readMobileAccessConfig(configPath);
    expect(stored.mode).toBe("trusted-proxy");
    expect(stored.enabled).toBe(false);
    expect(FS.readFileSync(configPath, "utf8")).not.toContain("192.168.1.24");
  });

  it("recognizes only the two known modes", () => {
    expect(isMobileAccessMode("trusted-proxy")).toBe(true);
    expect(isMobileAccessMode("private-lan")).toBe(true);
    expect(isMobileAccessMode("public")).toBe(false);
    expect(isMobileAccessMode(undefined)).toBe(false);
  });
});

describe("mobile access IPC input validation", () => {
  it("accepts a well-formed policy", () => {
    expect(
      isMobileAccessConfigInput({
        enabled: true,
        mode: "trusted-proxy",
        publicBaseUrl: "https://mac.tail1234.ts.net",
        approvedRoots: ["/Users/owner/code"],
      }),
    ).toBe(true);
  });

  it("rejects anything the renderer could bend into a different shape", () => {
    expect(isMobileAccessConfigInput(null)).toBe(false);
    expect(isMobileAccessConfigInput("enabled")).toBe(false);
    expect(
      isMobileAccessConfigInput({ enabled: "yes", mode: "trusted-proxy", approvedRoots: [] }),
    ).toBe(false);
    expect(isMobileAccessConfigInput({ enabled: true, mode: "public", approvedRoots: [] })).toBe(
      false,
    );
    expect(isMobileAccessConfigInput({ enabled: true, mode: "trusted-proxy" })).toBe(false);
    expect(
      isMobileAccessConfigInput({ enabled: true, mode: "trusted-proxy", approvedRoots: [1] }),
    ).toBe(false);
    expect(
      isMobileAccessConfigInput({
        enabled: true,
        mode: "trusted-proxy",
        publicBaseUrl: 42,
        approvedRoots: [],
      }),
    ).toBe(false);
  });
});

describe("backend handoff", () => {
  it("passes only the config path, and the private-LAN capability only in development", () => {
    expect(mobileAccessBackendEnv({ configPath, privateLanAvailable: false })).toEqual({
      SYNARA_MOBILE_ACCESS_CONFIG: configPath,
    });
    expect(mobileAccessBackendEnv({ configPath, privateLanAvailable: true })).toEqual({
      SYNARA_MOBILE_ACCESS_CONFIG: configPath,
      SYNARA_MOBILE_ACCESS_ALLOW_PRIVATE_LAN: "1",
    });
  });

  it("never serializes the approved roots into the backend environment", () => {
    writeMobileAccessConfig(
      configPath,
      { enabled: true, mode: "trusted-proxy", approvedRoots: ["/Users/owner/secret-project"] },
      { privateLanAvailable: false },
    );

    const env = mobileAccessBackendEnv({ configPath, privateLanAvailable: false });
    expect(Object.values(env).join(" ")).not.toContain("secret-project");
  });
});

describe("deliberate restart pathway", () => {
  const mainSource = FS.readFileSync(Path.join(import.meta.dirname, "main.ts"), "utf8");

  function restartFunctionBody(name: string): string {
    const start = mainSource.indexOf(`async function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const end = mainSource.indexOf("\n}\n", start);
    return mainSource.slice(start, end);
  }

  it("applies configuration through its own entry point rather than the crash path", () => {
    const applyHandler = mainSource.slice(mainSource.indexOf("IPC.mobileAccess.apply"));
    expect(applyHandler).toContain("restartBackendForConfigurationChange(");
    expect(applyHandler.slice(0, applyHandler.indexOf("IPC.mobileAccess.pickRoot"))).not.toContain(
      "restartBackendAfterCrash",
    );
  });

  it("starts the backend on the lifecycle trigger and touches no crash supervision", () => {
    const body = restartFunctionBody("restartBackendForConfigurationChange");

    expect(body).toContain('startBackend("lifecycle")');
    expect(body).not.toContain("crash-restart");
    expect(body).not.toContain("backendSupervision.");
    expect(body).not.toContain("respondToStartFailure");
    expect(body).not.toContain("scheduleBackendRestart");
    expect(body).not.toContain("presentBackendStartupGiveUp");
    // A pending crash-restart timer must not fire on top of the deliberate start.
    expect(body).toContain("clearTimeout(restartTimer)");
    expect(body).toContain("stopBackendAndWaitForExit()");
  });
});
