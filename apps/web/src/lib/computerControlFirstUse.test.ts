import { describe, expect, it, vi } from "vitest";

import type { DesktopComputerControlPermissionState } from "@synara/contracts";

import { preflightComputerControlPermissions } from "./computerControlFirstUse";

const READY: DesktopComputerControlPermissionState = {
  supported: true,
  screenRecordingPermission: "granted",
  accessibilityPermission: "granted",
  ready: true,
  message: null,
};

const NEEDS_PERMISSION: DesktopComputerControlPermissionState = {
  supported: true,
  screenRecordingPermission: "not-determined",
  accessibilityPermission: "not-determined",
  ready: false,
  message: "Allow Screen Recording and Accessibility for Synara.",
};

const DENIED: DesktopComputerControlPermissionState = {
  ...NEEDS_PERMISSION,
  screenRecordingPermission: "denied",
  accessibilityPermission: "denied",
  message: "Synara needs Screen Recording and Accessibility in System Settings.",
};

/** A scripted bridge: `states` is consumed one `getPermissionState` at a time. */
function makeBridge(options: {
  readonly states: readonly DesktopComputerControlPermissionState[];
  readonly requested?: DesktopComputerControlPermissionState;
}) {
  const remaining = [...options.states];
  let last = options.states[options.states.length - 1] ?? NEEDS_PERMISSION;
  return {
    getPermissionState: vi.fn(async () => {
      last = remaining.shift() ?? last;
      return last;
    }),
    requestPermissions: vi.fn(async () => options.requested ?? NEEDS_PERMISSION),
  };
}

/** Advances the injected clock so a poll loop terminates without real time. */
function makeClock(stepMs: number) {
  let value = 0;
  return {
    now: () => value,
    sleep: async (milliseconds: number) => {
      value += milliseconds === 0 ? stepMs : milliseconds;
    },
  };
}

describe("preflightComputerControlPermissions", () => {
  it("reports not-desktop when there is no desktop bridge", async () => {
    await expect(preflightComputerControlPermissions(undefined)).resolves.toEqual({
      kind: "not-desktop",
    });
  });

  it("reports not-desktop when the platform does not support computer control", async () => {
    const bridge = makeBridge({ states: [{ ...NEEDS_PERMISSION, supported: false }] });
    await expect(preflightComputerControlPermissions(bridge)).resolves.toEqual({
      kind: "not-desktop",
    });
    expect(bridge.requestPermissions).not.toHaveBeenCalled();
  });

  it("never prompts when the grants are already in place", async () => {
    const bridge = makeBridge({ states: [READY] });
    const onPermissionRequest = vi.fn();

    await expect(
      preflightComputerControlPermissions(bridge, { onPermissionRequest }),
    ).resolves.toEqual({ kind: "ready", state: READY });
    expect(bridge.requestPermissions).not.toHaveBeenCalled();
    expect(onPermissionRequest).not.toHaveBeenCalled();
  });

  it("resumes as soon as the user grants the permission in System Settings", async () => {
    // The request call returns before the user has answered, so readiness only
    // shows up on a later poll — the case the poll loop exists for.
    const bridge = makeBridge({ states: [NEEDS_PERMISSION, NEEDS_PERMISSION, READY] });
    const clock = makeClock(500);
    const onPermissionRequest = vi.fn();

    await expect(
      preflightComputerControlPermissions(bridge, {
        onPermissionRequest,
        now: clock.now,
        sleep: clock.sleep,
      }),
    ).resolves.toEqual({ kind: "ready", state: READY });
    expect(onPermissionRequest).toHaveBeenCalledTimes(1);
    expect(bridge.requestPermissions).toHaveBeenCalledTimes(1);
    // Two polls: one still-missing, then the grant.
    expect(bridge.getPermissionState).toHaveBeenCalledTimes(3);
  });

  it("gives up after the timeout and reports what is still missing", async () => {
    const bridge = makeBridge({ states: [DENIED], requested: DENIED });
    const clock = makeClock(500);

    await expect(
      preflightComputerControlPermissions(bridge, {
        timeoutMs: 2_000,
        pollIntervalMs: 500,
        now: clock.now,
        sleep: clock.sleep,
      }),
    ).resolves.toEqual({ kind: "permission-required", state: DENIED });
    // Bounded: it must not poll forever against a grant the user refused.
    expect(bridge.getPermissionState.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it("stops waiting the moment it is aborted", async () => {
    const controller = new AbortController();
    const bridge = makeBridge({ states: [NEEDS_PERMISSION] });
    const clock = makeClock(500);

    const preflight = preflightComputerControlPermissions(bridge, {
      signal: controller.signal,
      now: clock.now,
      sleep: async (milliseconds) => {
        // The user leaves while the System Settings pane is open.
        controller.abort();
        await clock.sleep(milliseconds);
      },
    });

    await expect(preflight).resolves.toEqual({ kind: "aborted" });
  });

  it("does nothing at all when it starts already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const bridge = makeBridge({ states: [NEEDS_PERMISSION] });

    await expect(
      preflightComputerControlPermissions(bridge, { signal: controller.signal }),
    ).resolves.toEqual({ kind: "aborted" });
    expect(bridge.getPermissionState).not.toHaveBeenCalled();
    expect(bridge.requestPermissions).not.toHaveBeenCalled();
  });
});
