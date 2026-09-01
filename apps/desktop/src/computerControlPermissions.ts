// FILE: computerControlPermissions.ts
// Purpose: macOS privacy preflight for real-desktop computer use, asked of the signed helper.
// Layer: Desktop IPC adapter
// Depends on: Electron systemPreferences/shell and the bundled Swift computer-use helper.
//
// The preflight runs in the signed desktop process, and asks the helper bundle
// rather than Electron, for one reason: macOS attributes a TCC grant to the
// binary that asked for it. Probing from an agent's shell puts *Terminal* in
// Privacy & Security, and probing Electron's own grants answers a question
// about Electron, not about the helper that will actually capture the screen.
//
// Three things this owns that the inline version in main.ts did not:
//
//   * **One helper at a time.** Every probe and request is chained onto a single
//     queue, and a probe already in flight is shared rather than re-run. The
//     renderer polls this every 500 ms while a permission dialog is open, so an
//     unqueued implementation spawned a process per poll and could stack two
//     identical TCC dialogs when two sends raced.
//   * **A grant the helper actually has.** When the helper cannot answer, that
//     is reported as a failure. Substituting Electron's own grants let the
//     preflight say `ready` while the helper had nothing, and the send then
//     failed downstream with a worse message.
//   * **Somewhere to go.** macOS shows its prompt once per bundle; after that
//     the request calls return false with no UI. A second request therefore
//     opens the relevant Privacy pane and says so, instead of leaving the user
//     polling a dialog that will never appear.

import { execFile } from "node:child_process";
import * as FS from "node:fs";

import type { IpcMain, Shell, SystemPreferences } from "electron";
import type {
  DesktopAppSnapPermission,
  DesktopComputerControlPermissionState,
} from "@synara/contracts";

import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

/** A probe is a read; it must not outlive the poll interval by much. */
const PROBE_TIMEOUT_MS = 10_000;
/** A request can sit behind a TCC dialog the user has not answered yet. */
const REQUEST_TIMEOUT_MS = 120_000;

const SCREEN_RECORDING_PANE =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
const ACCESSIBILITY_PANE =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

export type ComputerControlHelperArgument = "--probe" | "--request-permissions";

/** What the helper prints for `--probe` and `--request-permissions`. */
interface HelperPermissionReport {
  readonly screenRecording: boolean;
  readonly accessibility: boolean;
}

export interface ComputerControlPermissionsOptions {
  readonly platform: NodeJS.Platform;
  /** The helper bundle's executable, or null when this build has none. */
  readonly resolveHelperPath: () => string | null;
  /** Runs the helper and resolves its stdout. Injected so tests never exec. */
  readonly runHelper?: (
    helperPath: string,
    argument: ComputerControlHelperArgument,
  ) => Promise<string>;
  /** Electron's own grants, used only to describe a build with no helper. */
  readonly systemPreferences?: Pick<
    SystemPreferences,
    "getMediaAccessStatus" | "isTrustedAccessibilityClient"
  >;
  readonly openExternal?: Shell["openExternal"];
}

function unsupportedState(message: string): DesktopComputerControlPermissionState {
  return {
    supported: false,
    screenRecordingPermission: "unknown",
    accessibilityPermission: "unknown",
    ready: false,
    message,
  };
}

/**
 * The last JSON object the helper printed. Taking the last line rather than the
 * whole of stdout means a diagnostic the helper logs first cannot turn a
 * successful probe into a parse failure.
 */
function parseHelperReport(stdout: string): HelperPermissionReport | null {
  const lines = stdout.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line || !line.startsWith("{")) continue;
    try {
      const payload = JSON.parse(line) as Record<string, unknown>;
      return {
        screenRecording: payload.screenRecording === true,
        accessibility: payload.accessibility === true,
      };
    } catch {
      // Not the JSON line; keep walking backwards.
    }
  }
  return null;
}

function runHelperWithExecFile(
  helperPath: string,
  argument: ComputerControlHelperArgument,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      helperPath,
      [argument],
      {
        encoding: "utf8",
        timeout: argument === "--probe" ? PROBE_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
        // A permission report is one short line; anything larger is a runaway.
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => {
        // A non-zero exit still counts when the report itself came through:
        // the grant is the answer, not the exit code.
        if (error && !parseHelperReport(stdout)) reject(error);
        else resolve(stdout);
      },
    );
  });
}

/**
 * Owns the macOS computer-control privacy preflight for the desktop app.
 * Construction touches nothing; the first `getState()` resolves the helper.
 */
export class DesktopComputerControlPermissions {
  readonly #options: ComputerControlPermissionsOptions;
  readonly #runHelper: (
    helperPath: string,
    argument: ComputerControlHelperArgument,
  ) => Promise<string>;
  /** Serializes helper invocations so two sends cannot stack two TCC dialogs. */
  #queue: Promise<void> = Promise.resolve();
  /** A probe already in flight is shared rather than re-run behind it. */
  #probeInFlight: Promise<DesktopComputerControlPermissionState> | null = null;
  /** Resolved once and re-checked only if the file disappears. */
  #helperPath: string | null = null;
  /**
   * Whether this session has already asked macOS. The prompt only appears once
   * per bundle, so a still-missing grant after a request means the user has
   * answered — the state is `denied`, and re-requesting shows nothing.
   */
  #requestedScreenRecording = false;
  #requestedAccessibility = false;

  constructor(options: ComputerControlPermissionsOptions) {
    this.#options = options;
    this.#runHelper = options.runHelper ?? runHelperWithExecFile;
  }

  get supported(): boolean {
    return this.#options.platform === "darwin";
  }

  /** The current grants, without prompting. */
  async getState(): Promise<DesktopComputerControlPermissionState> {
    if (!this.supported) {
      return unsupportedState("Computer control is available in the Synara macOS app.");
    }
    const existing = this.#probeInFlight;
    if (existing) return await existing;
    const probe = this.#enqueue(() => this.#probe()).finally(() => {
      this.#probeInFlight = null;
    });
    this.#probeInFlight = probe;
    return await probe;
  }

  /**
   * Asks macOS for anything still missing, then reports where that left things.
   * On a second ask — the prompt has already been answered — this opens the
   * Privacy pane instead, because nothing else will put a dialog on screen.
   */
  async request(): Promise<DesktopComputerControlPermissionState> {
    if (!this.supported) {
      return unsupportedState("Computer control is available in the Synara macOS app.");
    }
    return await this.#enqueue(async () => {
      const before = await this.#probe();
      if (before.ready || !before.supported) return before;

      const alreadyAsked =
        (before.screenRecordingPermission !== "granted" && this.#requestedScreenRecording) ||
        (before.accessibilityPermission !== "granted" && this.#requestedAccessibility);
      if (alreadyAsked) {
        await this.#openPrivacyPanes(before);
        return before;
      }

      const helperPath = this.#resolveHelper();
      if (!helperPath) return before;
      if (before.screenRecordingPermission !== "granted") this.#requestedScreenRecording = true;
      if (before.accessibilityPermission !== "granted") this.#requestedAccessibility = true;

      let after: DesktopComputerControlPermissionState;
      try {
        const report = parseHelperReport(
          await this.#runHelper(helperPath, "--request-permissions"),
        );
        after = report
          ? this.#stateFromReport(report)
          : this.#helperFailureState("The computer-control helper did not report its permissions.");
      } catch (error) {
        after = this.#helperFailureState(error instanceof Error ? error.message : String(error));
      }
      // A grant that is still missing after the one prompt macOS will show is
      // only reachable through System Settings, so open it rather than leaving
      // the renderer polling for a dialog that has already come and gone.
      if (!after.ready && after.supported) await this.#openPrivacyPanes(after);
      return after;
    });
  }

  // ── Internals ──────────────────────────────────────────────────────

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #probe(): Promise<DesktopComputerControlPermissionState> {
    const helperPath = this.#resolveHelper();
    if (!helperPath) return this.#noHelperState();
    try {
      const report = parseHelperReport(await this.#runHelper(helperPath, "--probe"));
      return report
        ? this.#stateFromReport(report)
        : this.#helperFailureState("The computer-control helper did not report its permissions.");
    } catch (error) {
      return this.#helperFailureState(error instanceof Error ? error.message : String(error));
    }
  }

  #resolveHelper(): string | null {
    if (this.#helperPath && FS.existsSync(this.#helperPath)) return this.#helperPath;
    this.#helperPath = this.#options.resolveHelperPath();
    return this.#helperPath;
  }

  #stateFromReport(report: HelperPermissionReport): DesktopComputerControlPermissionState {
    return this.#state(
      this.#grant(report.screenRecording, this.#requestedScreenRecording),
      this.#grant(report.accessibility, this.#requestedAccessibility),
    );
  }

  /**
   * macOS exposes no way to read "the user said no" — both a fresh install and
   * a refusal preflight as false. What distinguishes them is whether the one
   * prompt has been spent, which is something this process knows.
   */
  #grant(granted: boolean, alreadyRequested: boolean): DesktopAppSnapPermission {
    if (granted) return "granted";
    return alreadyRequested ? "denied" : "not-determined";
  }

  #state(
    screenRecordingPermission: DesktopAppSnapPermission,
    accessibilityPermission: DesktopAppSnapPermission,
  ): DesktopComputerControlPermissionState {
    const ready = screenRecordingPermission === "granted" && accessibilityPermission === "granted";
    const missing = [
      ...(screenRecordingPermission === "granted" ? [] : ["Screen Recording"]),
      ...(accessibilityPermission === "granted" ? [] : ["Accessibility"]),
    ];
    const denied = screenRecordingPermission === "denied" || accessibilityPermission === "denied";
    return {
      supported: true,
      screenRecordingPermission,
      accessibilityPermission,
      ready,
      message: ready
        ? null
        : denied
          ? `Synara needs ${missing.join(" and ")} in System Settings › Privacy & Security. ` +
            "We opened it for you — switch Synara on there, then send again."
          : `Allow ${missing.join(" and ")} for Synara when macOS asks, then send again.`,
    };
  }

  /**
   * The helper is present but could not answer. This is reported rather than
   * papered over: Electron's own grants describe a different binary, and
   * answering with them can claim `ready` while the helper has nothing.
   */
  #helperFailureState(detail: string): DesktopComputerControlPermissionState {
    return {
      supported: true,
      screenRecordingPermission: "unknown",
      accessibilityPermission: "unknown",
      ready: false,
      message: `Synara could not check its computer-control permissions: ${detail}`,
    };
  }

  /**
   * A development build with no helper compiled yet. Electron's grants are the
   * honest answer here, because in this shape Electron is what would capture.
   */
  #noHelperState(): DesktopComputerControlPermissionState {
    const preferences = this.#options.systemPreferences;
    if (!preferences) {
      return {
        supported: true,
        screenRecordingPermission: "unknown",
        accessibilityPermission: "unknown",
        ready: false,
        message:
          "This build has no computer-control helper. Run `node apps/desktop/scripts/build-computer-helper.mjs` to build one.",
      };
    }
    const rawScreen = preferences.getMediaAccessStatus("screen");
    const screenRecordingPermission: DesktopAppSnapPermission =
      rawScreen === "granted" ||
      rawScreen === "denied" ||
      rawScreen === "restricted" ||
      rawScreen === "not-determined"
        ? rawScreen
        : "unknown";
    const accessibilityPermission: DesktopAppSnapPermission =
      preferences.isTrustedAccessibilityClient(false)
        ? "granted"
        : this.#requestedAccessibility
          ? "denied"
          : "not-determined";
    return this.#state(screenRecordingPermission, accessibilityPermission);
  }

  async #openPrivacyPanes(state: DesktopComputerControlPermissionState): Promise<void> {
    const openExternal = this.#options.openExternal;
    if (!openExternal) return;
    // One pane only: two `open` calls race in System Settings and the second
    // wins, so the user would land on whichever we asked for last.
    const pane =
      state.screenRecordingPermission === "granted" ? ACCESSIBILITY_PANE : SCREEN_RECORDING_PANE;
    await openExternal(pane).catch(() => undefined);
  }
}

export function registerComputerControlIpcHandlers(
  ipcMain: IpcMain,
  permissions: DesktopComputerControlPermissions,
): void {
  ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.computerControl.getPermissionState);
  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.computerControl.getPermissionState,
    async () => await permissions.getState(),
  );

  ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.computerControl.requestPermissions);
  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.computerControl.requestPermissions,
    async () => await permissions.request(),
  );
}
