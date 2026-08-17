/**
 * Tier 2 end to end, against a real wlroots compositor.
 *
 * Off unless `SYNARA_NESTED_WLROOTS_TEST` is set: it boots sway on the headless
 * wlroots backend, which no ordinary test run and no CI runner without sway can
 * do. The compositor it starts has no window on the developer's screen and no
 * input devices of its own — `WLR_BACKENDS=headless` with
 * `WLR_LIBINPUT_NO_DEVICES=1` — so the only events its seat ever sees are the
 * ones this lane injects, on a private `WAYLAND_DISPLAY` the human's session
 * never learns about.
 *
 *   SYNARA_NESTED_WLROOTS_TEST=1 bunx vitest run src/computer/portal/wlrootsSession.integration.test.ts
 *
 * This is the only lane that can prove the C helper: every other test in this
 * directory stands in for it with a fake transport, which cannot catch a wrong
 * evdev offset, a malformed xkb keymap, or a screencopy buffer read at the
 * wrong stride. So the assertions go through the compositor's own account of
 * what happened — a sway keybinding firing, sway's own output list — rather
 * than through the helper that is under test.
 */
import { execFileSync, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ComputerRect } from "@synara/contracts";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createDesktopHelperIdleSource,
  DEFAULT_IDLE_ARM_MS,
  HUMAN_ACTIVE_REFUSAL,
  SharedSeatArbiter,
} from "../sharedSeatArbiter.ts";
import { startSupervisedProcess, type SupervisedProcess } from "../supervisedProcess.ts";
import { DesktopHelperClient } from "./desktopHelperClient.ts";
import {
  createPortalComputerBackend,
  type PortalComputerBackend,
} from "./PortalComputerBackend.ts";
import { desktopHelperPath, probeDesktop, type PortalProbe } from "./probe.ts";

/**
 * Two outputs side by side. The second one exists because it is only reachable
 * by treating the two as a single desktop coordinate space, which is the
 * conversion every click in this tier depends on.
 */
const OUTPUT_MODES = [
  { name: "HEADLESS-1", width: 1280, height: 800, x: 0, y: 0 },
  { name: "HEADLESS-2", width: 800, height: 600, x: 1280, y: 0 },
] as const;
const BOOT_TIMEOUT_MS = 30_000;
const SETTLE_TIMEOUT_MS = 10_000;
const WINDOW_TIMEOUT_MS = 30_000;
const POLL_MS = 100;
/** A Wayland client with a real toplevel, for the parts that need a window. */
const TEST_CLIENTS = ["foot", "alacritty", "kitty", "gtk4-demo", "weston-terminal"] as const;

interface HeadlessSession {
  readonly display: string;
  readonly env: NodeJS.ProcessEnv;
  readonly dir: string;
  readonly process: SupervisedProcess;
}

interface SwayOutput {
  readonly name: string;
  readonly rect: ComputerRect;
  readonly focused: boolean;
}

const HELPER_PATH = desktopHelperPath();
const MISSING = [
  ...(commandExists("sway") ? [] : ["sway (dnf install sway)"]),
  ...(commandExists("swaymsg") ? [] : ["swaymsg, which ships with the sway package"]),
  ...(isExecutable(HELPER_PATH)
    ? []
    : [
        `the native helper at ${HELPER_PATH} (apps/server/native/computer-desktop-helper/build.sh)`,
      ]),
];
const TEST_CLIENT = TEST_CLIENTS.find((candidate) => commandExists(candidate));

describe.skipIf(!process.env.SYNARA_NESTED_WLROOTS_TEST)("wlroots desktop", () => {
  it("has everything the live lane needs installed", () => {
    // Loud rather than quiet: this lane only runs when it was asked for by
    // name, so skipping silently would report a pass for a run that never
    // happened.
    expect(MISSING).toEqual([]);
  });

  describe.skipIf(MISSING.length > 0)("driven end to end", () => {
    let session: HeadlessSession;
    let backend: PortalComputerBackend;
    let probe: PortalProbe;
    let outputs: readonly SwayOutput[];
    let workspace: ComputerRect;

    beforeAll(async () => {
      session = await startHeadlessSession();
      // sway's own geometry, not the requested modes: a compositor that refused
      // a mode should fail the comparison below, not silently redefine it.
      outputs = readOutputs(session);
      workspace = unionRect(outputs.map((output) => output.rect));
      probe = await probeDesktop({ env: session.env });
      backend = createPortalComputerBackend(probe, {
        providerOptions: { env: session.env },
        // Instant glides: the sequencer's timing is unit-tested, and a live
        // lane that waits out every animation is a lane nobody runs.
        glideDurationMs: 0,
        // Launched apps have to land in the nested session, not the human's.
        spawnProcess: (app, args) =>
          spawn(app, [...args], { detached: true, stdio: "ignore", env: session.env }),
      });
    }, BOOT_TIMEOUT_MS);

    afterAll(async () => {
      await backend?.dispose();
      await session?.process.terminate();
    });

    it("recognizes sway as a wlroots desktop with every protocol this tier wants", () => {
      expect(probe.desktop).toBe("wlroots");
      expect(probe.waylandGlobals).toEqual(
        expect.arrayContaining([
          "zwlr_virtual_pointer_manager_v1",
          "zwp_virtual_keyboard_manager_v1",
          "zwlr_screencopy_manager_v1",
          "zwlr_foreign_toplevel_management_v1",
          // Tier 2 shares the human's seat, so being able to tell whether they
          // are using it is part of what makes this desktop supportable.
          "ext_idle_notifier_v1",
        ]),
      );
      const plan = backend.providerPlan();
      expect(plan.input.implementation).toBe("wlroots-virtual-input");
      expect(plan.capture.implementation).toBe("wlr-screencopy");
      expect(plan.windows.implementation).toBe("wlr-foreign-toplevel");
      expect(plan.clipboard.implementation).toBe("wl-clipboard");
      for (const choice of Object.values(plan)) expect(choice.blockedBy).toBeUndefined();
    });

    it("reports capabilities this desktop can actually back", async () => {
      await expect(backend.availability()).resolves.toEqual({
        kind: "available",
        backend: "portal",
      });
      expect(backend.health().status).toBe("connected");
      expect(backend.capabilities()).toMatchObject({
        capture: true,
        input: true,
        windows: true,
        clipboard: true,
        // The foreign-toplevel protocol carries neither geometry nor stacking,
        // and the capability object is where that stops being a surprise.
        windowBounds: false,
        stacking: false,
        activation: true,
        sharedSeat: true,
        ghostCursor: false,
      });
    });

    it("agrees with sway about the size of the desktop", async () => {
      await expect(backend.getScreenSize()).resolves.toMatchObject({
        width: workspace.width,
        height: workspace.height,
      });
      expect(outputs).toHaveLength(OUTPUT_MODES.length);
    });

    it("lists the windows of an empty desktop as none", async () => {
      await expect(backend.listWindows()).resolves.toEqual([]);
    });

    it("captures a region at the size that was asked for", async () => {
      const screenshot = await backend.captureScreenshot({
        kind: "region",
        region: { x: 0, y: 0, width: 640, height: 480 },
        maxDimension: 4096,
      });

      expect(screenshot.mimeType).toBe("image/png");
      expect(screenshot.width).toBe(640);
      expect(screenshot.height).toBe(480);
      expect(Buffer.from(screenshot.bytesBase64, "base64").subarray(0, 8)).toEqual(
        Buffer.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
      );
    });

    it("composites both outputs into one desktop-space image", async () => {
      // Screencopy hands over one output at a time in that output's own
      // coordinates, so a helper that placed them wrong still produces an image
      // of the right size — with the second monitor in the wrong half.
      const screenshot = await backend.captureScreenshot({
        kind: "region",
        region: workspace,
        maxDimension: 4096,
      });

      expect(screenshot.width).toBe(workspace.width);
      expect(screenshot.height).toBe(workspace.height);
    });

    it("clips a capture that overhangs the desktop, and says so", async () => {
      const screenshot = await backend.captureScreenshot({
        kind: "region",
        region: { x: workspace.width - 200, y: 0, width: 1000, height: 200 },
        maxDimension: 4096,
      });

      // 200 wide, not 1000: the region carried back with the pixels is what a
      // caller scales its clicks against, so it has to be the covered one.
      expect(screenshot.width).toBe(200);
      expect(screenshot.region).toMatchObject({ x: workspace.width - 200, width: 200 });
    });

    it("moves the pointer in desktop coordinates, across outputs", async () => {
      // sway's focus follows the cursor, so its output list is an independent
      // witness that absolute motion landed where it was aimed — and the second
      // output is only reachable if the desktop is one coordinate space.
      for (const output of outputs) {
        await backend.moveCursor(centerOf(output.rect));
        await expect(
          waitFor(() => readOutputs(session).find((entry) => entry.focused)?.name === output.name),
        ).resolves.toBe(true);
      }
    });

    it("presses a hotkey the compositor recognizes as that hotkey", async () => {
      // The keymap is the risky part of the helper: a chord fires only if the
      // uploaded xkb map agrees with the evdev codes being sent, so sway's own
      // binding firing is the proof that it does.
      await backend.hotkey(["ctrl", "alt", "f12"]);

      await expect(waitFor(() => fileExists(join(session.dir, "hotkey")))).resolves.toBe(true);
    });

    it("types a character that arrives as that character", async () => {
      await backend.typeText("z");

      await expect(waitFor(() => fileExists(join(session.dir, "typed")))).resolves.toBe(true);
    });

    it("round-trips the nested session's own clipboard", async () => {
      await backend.writeClipboard("tier two clipboard");

      await expect(backend.readClipboard()).resolves.toBe("tier two clipboard");
    });

    it("refuses to raise a window, which this protocol cannot do", async () => {
      await expect(backend.raiseWindow("toplevel-0")).rejects.toThrow(/no stacking control/);
    });

    it.skipIf(TEST_CLIENT === undefined)(
      "sees a real client's window, without bounds, and refuses what bounds would buy",
      async () => {
        await backend.launchApp(TEST_CLIENT!, []);
        const window = await waitForValue(async () => (await backend.listWindows())[0]);

        expect(window.title.length).toBeGreaterThan(0);
        // No geometry: the protocol has none, and a window reported at the
        // origin is the lie that sends clicks somewhere nobody aimed.
        expect(window.bounds).toBeUndefined();
        await expect(
          backend.captureScreenshot({ kind: "window", windowId: window.id }),
        ).rejects.toThrow(/bounds/i);

        await backend.focusWindow(window.id);
        await expect(
          waitFor(async () => (await backend.listWindows())[0]?.focused === true),
        ).resolves.toBe(true);
      },
      WINDOW_TIMEOUT_MS,
    );

    it(
      "gives the shared seat back to input the agent did not send",
      async () => {
        // The arbiter's own logic is unit-tested; what only sway can show is that
        // `ext_idle_notify_v1` behaves the way the source reads it — that the
        // notification fires at all, that injected input resets the seat's idle
        // clock, and that the two transitions arrive in time to decide an action.
        //
        // A second helper stands in for the human: its input reaches the same
        // `wl_seat` the backend's does, and the arbiter is never told about it,
        // which is exactly the situation it exists for.
        const human = new DesktopHelperClient({
          command: HELPER_PATH,
          env: session.env,
        });
        const arbiter = new SharedSeatArbiter({
          source: createDesktopHelperIdleSource(human),
        });
        const allowed = () =>
          arbiter.guardMutation().then(
            () => true,
            () => false,
          );
        try {
          await expect(human.idleState(DEFAULT_IDLE_ARM_MS)).resolves.toMatchObject({
            timeoutMs: DEFAULT_IDLE_ARM_MS,
          });
          // Waits rather than asserts: the notification is blind for its whole
          // window after arming, and the earlier tests left the seat busy.
          await expect(waitFor(allowed)).resolves.toBe(true);

          await human.pointerMotion(...pointOn(outputs[0]!.rect, 0.25));
          await human.pointerMotion(...pointOn(outputs[0]!.rect, 0.75));

          await expect(
            waitFor(async () => !(await allowed())),
            "the seat saw input from outside the agent and the agent kept going",
          ).resolves.toBe(true);
          await expect(arbiter.guardMutation()).rejects.toThrow(HUMAN_ACTIVE_REFUSAL);
          expect(arbiter.status()).toMatchObject({ observing: true });

          // And takes it back on its own once the seat goes quiet, with no reset
          // and nothing to clear: a yield that needed acknowledging would strand
          // the turn on a human who walked away.
          await expect(waitFor(allowed)).resolves.toBe(true);

          // Its own input is not a human's, even though the compositor cannot
          // tell them apart — `guarded` notes the action after the motion lands,
          // so the burst it just started is accounted for.
          await arbiter.guarded(() => human.pointerMotion(...pointOn(outputs[0]!.rect, 0.5)));
          await expect(arbiter.guardMutation()).resolves.toBeUndefined();
        } finally {
          await human.dispose();
        }
      },
      BOOT_TIMEOUT_MS,
    );

    it("refuses rather than reporting an empty desktop once the compositor is gone", async () => {
      // Runs last, and deliberately: the failure mode this whole tier exists to
      // avoid is a dead desktop that answers "no windows".
      await session.process.terminate();

      await expect(
        waitFor(() =>
          backend.listWindows().then(
            () => false,
            () => true,
          ),
        ),
      ).resolves.toBe(true);
    });
  });
});

/**
 * Boots sway on the headless backend and waits for it to say which display it
 * created.
 *
 * The socket name comes from sway itself, through an `exec` line: wlroots takes
 * the first free `wayland-N`, and guessing it would race the human's session.
 */
async function startHeadlessSession(): Promise<HeadlessSession> {
  const dir = await mkdtemp(join(tmpdir(), "synara-wlroots-"));
  const configPath = join(dir, "config");
  const touch = (name: string) => `exec sh -c 'printf 1 > ${join(dir, name)}'`;
  await writeFile(
    configPath,
    [
      ...OUTPUT_MODES.map(
        (output) =>
          `output ${output.name} mode ${output.width}x${output.height} position ${output.x} ${output.y}`,
      ),
      "focus_follows_mouse yes",
      // The witnesses. Each fires only if the injected event reached the seat
      // with the modifiers and the keysym the helper claimed to send.
      `bindsym Ctrl+Alt+F12 ${touch("hotkey")}`,
      `bindsym --no-repeat z ${touch("typed")}`,
      `exec sh -c 'printf "%s" "$WAYLAND_DISPLAY" > ${join(dir, "display")}'`,
      "",
    ].join("\n"),
    "utf8",
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WLR_BACKENDS: "headless",
    WLR_HEADLESS_OUTPUTS: String(OUTPUT_MODES.length),
    WLR_LIBINPUT_NO_DEVICES: "1",
    SWAYSOCK: join(dir, "sway.sock"),
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? dir,
    XDG_CURRENT_DESKTOP: "sway",
    XDG_SESSION_TYPE: "wayland",
  };
  // Inherited, these would have sway nest a window inside the developer's own
  // session — or start on X11 — instead of running headless.
  delete env.WAYLAND_DISPLAY;
  delete env.DISPLAY;

  const child = startSupervisedProcess({
    command: "sway",
    args: ["--config", configPath],
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const displayPath = join(dir, "display");
  if (!(await waitFor(() => fileExists(displayPath), BOOT_TIMEOUT_MS))) {
    await child.terminate();
    throw new Error(`sway did not come up within ${BOOT_TIMEOUT_MS} ms.${child.diagnostic()}`);
  }
  const display = (await readFile(displayPath, "utf8")).trim();
  return { display, dir, process: child, env: { ...env, WAYLAND_DISPLAY: display } };
}

/** sway's own view of its outputs, which the helper's geometry is checked against. */
function readOutputs(session: HeadlessSession): readonly SwayOutput[] {
  const raw = execFileSync("swaymsg", ["-t", "get_outputs", "--raw"], {
    env: session.env,
    encoding: "utf8",
  });
  const parsed = JSON.parse(raw) as readonly {
    name: string;
    focused?: boolean;
    rect: ComputerRect;
  }[];
  return parsed.map((output) => ({
    name: output.name,
    rect: output.rect,
    focused: output.focused === true,
  }));
}

function unionRect(rects: readonly ComputerRect[]): ComputerRect {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function centerOf(rect: ComputerRect): { readonly x: number; readonly y: number } {
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
}

/** A point at `fraction` across a rect, as the helper's absolute motion wants it. */
function pointOn(rect: ComputerRect, fraction: number): [number, number] {
  return [Math.round(rect.x + rect.width * fraction), Math.round(rect.y + rect.height * fraction)];
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = SETTLE_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const met = await Promise.resolve()
      .then(condition)
      .catch(() => false);
    if (met) return true;
    if (Date.now() >= deadline) return false;
    await delay(POLL_MS);
  }
}

async function waitForValue<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + WINDOW_TIMEOUT_MS;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() >= deadline) {
      throw new Error(`Nothing arrived within ${WINDOW_TIMEOUT_MS} ms.`);
    }
    await delay(POLL_MS);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function fileExists(path: string): Promise<boolean> {
  return readFile(path).then(
    () => true,
    () => false,
  );
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function commandExists(command: string): boolean {
  try {
    execFileSync("which", [command], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}
