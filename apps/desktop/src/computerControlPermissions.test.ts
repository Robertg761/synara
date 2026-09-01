import { describe, expect, it, vi } from "vitest";

import {
  DesktopComputerControlPermissions,
  type ComputerControlHelperArgument,
} from "./computerControlPermissions";

const HELPER_PATH = "/Applications/Synara.app/Contents/Helpers/Synara Computer Use.app/x";

function report(screenRecording: boolean, accessibility: boolean): string {
  return `${JSON.stringify({ ok: true, screenRecording, accessibility })}\n`;
}

function makePermissions(options: {
  readonly runHelper: (path: string, argument: ComputerControlHelperArgument) => Promise<string>;
  readonly helperPath?: string | null;
  readonly openExternal?: (url: string) => Promise<void>;
}) {
  const opened: string[] = [];
  const permissions = new DesktopComputerControlPermissions({
    platform: "darwin",
    resolveHelperPath: () => (options.helperPath === undefined ? HELPER_PATH : options.helperPath),
    runHelper: options.runHelper,
    openExternal: async (url: string) => {
      opened.push(url);
      await options.openExternal?.(url);
    },
  });
  return { permissions, opened };
}

describe("DesktopComputerControlPermissions", () => {
  it("reports the helper's grants, not Electron's", async () => {
    const runHelper = vi.fn(async () => report(true, true));
    const { permissions } = makePermissions({ runHelper });

    await expect(permissions.getState()).resolves.toMatchObject({
      supported: true,
      ready: true,
      screenRecordingPermission: "granted",
      accessibilityPermission: "granted",
      message: null,
    });
    expect(runHelper).toHaveBeenCalledWith(HELPER_PATH, "--probe");
  });

  it("ignores a diagnostic the helper logs before its JSON", async () => {
    const runHelper = vi.fn(async () => `dyld: some warning\n${report(true, true)}`);
    const { permissions } = makePermissions({ runHelper });

    await expect(permissions.getState()).resolves.toMatchObject({ ready: true });
  });

  it("reports a failure rather than substituting Electron's grants", async () => {
    const runHelper = vi.fn(async () => {
      throw new Error("spawn EACCES");
    });
    const { permissions } = makePermissions({ runHelper });

    // Answering with Electron's own grants here would let the preflight claim
    // `ready` while the helper that actually captures has nothing.
    const state = await permissions.getState();
    expect(state.ready).toBe(false);
    expect(state.screenRecordingPermission).toBe("unknown");
    expect(state.message).toContain("spawn EACCES");
  });

  it("serializes helper runs so two callers cannot stack two TCC prompts", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const runHelper = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return report(false, false);
    });
    const { permissions } = makePermissions({ runHelper });

    await Promise.all([permissions.request(), permissions.request()]);

    expect(maxInFlight).toBe(1);
  });

  it("shares one probe between concurrent callers instead of spawning per poll", async () => {
    const runHelper = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return report(true, true);
    });
    const { permissions } = makePermissions({ runHelper });

    await Promise.all([permissions.getState(), permissions.getState(), permissions.getState()]);

    expect(runHelper).toHaveBeenCalledTimes(1);
  });

  it("opens the Privacy pane when a grant is still missing after asking", async () => {
    const runHelper = vi.fn(async () => report(false, true));
    const { permissions, opened } = makePermissions({ runHelper });

    const state = await permissions.request();

    expect(state.ready).toBe(false);
    // macOS shows its prompt once; without somewhere to go the user is left
    // waiting for a dialog that has already come and gone.
    expect(opened).toEqual([
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    ]);
  });

  it("calls a grant denied once its one prompt has been spent, and says so", async () => {
    const arguments_: ComputerControlHelperArgument[] = [];
    const runHelper = async (_path: string, argument: ComputerControlHelperArgument) => {
      arguments_.push(argument);
      return report(false, true);
    };
    const { permissions } = makePermissions({ runHelper });

    const first = await permissions.request();
    expect(first.screenRecordingPermission).toBe("denied");
    expect(first.message).toContain("System Settings");

    // A second ask must not re-run the request: the prompt is spent, so the
    // helper would return the same answer with no UI shown.
    const before = arguments_.filter((value) => value === "--request-permissions").length;
    await permissions.request();
    const after = arguments_.filter((value) => value === "--request-permissions").length;
    expect(after).toBe(before);
  });

  it("describes a build with no helper instead of pretending it is unsupported", async () => {
    const runHelper = vi.fn(async () => report(true, true));
    const { permissions } = makePermissions({ runHelper, helperPath: null });

    const state = await permissions.getState();
    expect(state.supported).toBe(true);
    expect(state.ready).toBe(false);
    expect(state.message).toContain("build-computer-helper");
    expect(runHelper).not.toHaveBeenCalled();
  });

  it("reports unsupported off macOS without touching the helper", async () => {
    const runHelper = vi.fn(async () => report(true, true));
    const permissions = new DesktopComputerControlPermissions({
      platform: "win32",
      resolveHelperPath: () => HELPER_PATH,
      runHelper,
    });

    await expect(permissions.getState()).resolves.toMatchObject({ supported: false });
    await expect(permissions.request()).resolves.toMatchObject({ supported: false });
    expect(runHelper).not.toHaveBeenCalled();
  });
});
