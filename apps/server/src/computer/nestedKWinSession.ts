/**
 * Tier 3: a private KWin this server owns, for CI and headless hosts.
 *
 * A nested session is a dedicated session bus plus `kwin_wayland --virtual` on
 * it. Nothing about the desktop backend changes: the same KWin plugin loads
 * into the private compositor, and `KWinComputerBackend` reaches it through the
 * same D-Bus surface, only pointed at the private bus. It is opt-in and never a
 * fallback — a nested compositor standing in for a broken desktop would hand an
 * agent an invisible screen and report it as healthy.
 *
 * The compositor is not restarted if it dies. A nested crash takes the whole
 * session with it, so it surfaces the way a real KWin crash does: KWin's bus
 * names vanish, the backend's reconnect loop cannot find them, and health
 * reports the outage instead of hiding it behind a fresh empty desktop.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";

import { ComputerBackendError } from "./ComputerBackend.ts";
import { AtspiHelperClient, type AtspiTreeReader } from "./atspiClient.ts";
import {
  isSynaraPluginId,
  newestPluginId,
  scanInstalledPluginIds,
  type KWinComputerBackendOptions,
} from "./KWinComputerBackend.ts";
import {
  createSessionKWinComputerDbus,
  KWIN_SERVICE,
  waitForSessionBusName,
  type KWinComputerDbus,
} from "./kwinDbus.ts";
import { spawnClipboardCommand, type ClipboardCommandRunner } from "./wlClipboard.ts";

const DBUS_DAEMON_COMMAND = "dbus-daemon";
const KWIN_COMMAND = "kwin_wayland";
const DEFAULT_NESTED_WIDTH = 1_920;
const DEFAULT_NESTED_HEIGHT = 1_080;
const MIN_NESTED_DIMENSION = 64;
const MAX_NESTED_DIMENSION = 16_384;
const BUS_ADDRESS_TIMEOUT_MS = 10_000;
const KWIN_READY_TIMEOUT_MS = 30_000;
/** Enough compositor stderr to quote a startup failure, never a whole log. */
const MAX_DIAGNOSTIC_BYTES = 4 * 1024;
const TERMINATE_GRACE_MS = 2_000;
const NESTED_SIZE_PATTERN = /^(\d+)x(\d+)$/i;
const INSTALL_SCRIPT_PATH = "apps/server/native/computer-use-kwin/scripts/install-and-load.sh";

export interface NestedSize {
  readonly width: number;
  readonly height: number;
}

export interface NestedKWinSessionOptions {
  readonly size?: NestedSize;
  /** Wayland socket name; generated per session so two servers cannot collide. */
  readonly socketName?: string;
  readonly readyTimeoutMs?: number;
  readonly installedPluginIds?: () => Promise<readonly string[]>;
  /** Replaced in tests, which must never spawn a compositor. */
  readonly spawnProcess?: (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => ChildProcess;
  readonly connectDbus?: (busAddress: string) => Promise<KWinComputerDbus>;
  readonly waitForBusName?: typeof waitForSessionBusName;
}

export interface NestedKWinSession {
  readonly busAddress: string;
  readonly waylandDisplay: string;
  readonly size: NestedSize;
  /** The plugin id explicitly loaded, after every shadowing id was unloaded. */
  readonly pluginId: string;
  readonly dispose: () => Promise<void>;
}

/**
 * Boots the private bus and compositor, then leaves exactly one Synara plugin
 * loaded in it. Rejects with a message naming the step that failed, because
 * that message is all the availability card can show an operator.
 */
export async function startNestedKWinSession(
  options: NestedKWinSessionOptions = {},
): Promise<NestedKWinSession> {
  const spawnProcess = options.spawnProcess ?? spawnNestedProcess;
  const connectDbus =
    options.connectDbus ?? ((busAddress: string) => createSessionKWinComputerDbus({ busAddress }));
  const waitForBusName = options.waitForBusName ?? waitForSessionBusName;
  const installedPluginIds = options.installedPluginIds ?? (() => scanInstalledPluginIds());
  const size = normalizeNestedSize(options.size);
  const waylandDisplay = options.socketName ?? generateSocketName();
  const children: NestedProcess[] = [];
  const dispose = async () => {
    // Newest first: the compositor is torn down before the bus it announced
    // itself on, which keeps its exit from racing a dead bus.
    for (const child of children.toReversed()) await child.terminate();
  };

  try {
    const bus = start(spawnProcess, children, DBUS_DAEMON_COMMAND, [
      "--session",
      "--print-address=1",
      "--nofork",
    ]);
    const busAddress = await bus.readFirstStdoutLine(BUS_ADDRESS_TIMEOUT_MS);
    if (!busAddress.startsWith("unix:")) {
      throw new ComputerBackendError(
        `${DBUS_DAEMON_COMMAND} printed no usable bus address for the nested session.`,
      );
    }

    const kwin = start(
      spawnProcess,
      children,
      KWIN_COMMAND,
      [
        "--virtual",
        "--no-global-shortcuts",
        "--socket",
        waylandDisplay,
        "--width",
        String(size.width),
        "--height",
        String(size.height),
      ],
      compositorEnv(busAddress),
    );

    const timeoutMs = options.readyTimeoutMs ?? KWIN_READY_TIMEOUT_MS;
    const ready = await waitForBusName({
      busAddress,
      name: KWIN_SERVICE,
      timeoutMs,
      abort: () => kwin.exitDiagnostic() !== undefined,
    });
    if (!ready) throw kwinNotReadyError(kwin, timeoutMs);

    const dbus = await connectDbus(busAddress);
    let pluginId: string;
    try {
      pluginId = await loadNestedPlugin(dbus, await installedPluginIds());
    } finally {
      await dbus.close().catch(() => undefined);
    }
    return { busAddress, waylandDisplay, size, pluginId, dispose };
  } catch (error) {
    await dispose();
    throw error instanceof ComputerBackendError
      ? error
      : new ComputerBackendError(error instanceof Error ? error.message : String(error), {
          cause: error,
        });
  }
}

/** Environment that puts a child process inside the nested session. */
export function nestedSessionEnv(session: {
  readonly busAddress: string;
  readonly waylandDisplay: string;
}): NodeJS.ProcessEnv {
  return {
    WAYLAND_DISPLAY: session.waylandDisplay,
    DBUS_SESSION_BUS_ADDRESS: session.busAddress,
    // Qt defaults to whatever platform plugin the ambient session suggests, and
    // an app that picks xcb here would never reach the nested compositor.
    QT_QPA_PLATFORM: "wayland",
  };
}

/**
 * Whether the nested session's own accessibility perception is used.
 *
 * `off` is the default because the AT-SPI registry is per-user, not per session
 * bus: without a registry inside the nested session the helper either fails or,
 * worse, reads the human's real desktop and fuses it into the nested window
 * list. Hosts that do activate a registry on the nested bus — a CI container
 * with no ambient desktop — opt back in.
 */
export type NestedAtspiMode = "off" | "session";

export interface NestedBackendOptions {
  readonly atspiMode?: NestedAtspiMode;
}

/** Backend options that bind a `KWinComputerBackend` to a nested session. */
export function nestedKWinBackendOptions(
  session: NestedKWinSession,
  options: NestedBackendOptions = {},
): KWinComputerBackendOptions {
  const env = nestedSessionEnv(session);
  return {
    busAddress: session.busAddress,
    // The nested compositor is a Wayland session even when the server was
    // started from a tty or a CI runner with no session at all, so the platform
    // gate must not read the ambient session type.
    sessionType: "wayland",
    spawnProcess: nestedSpawnProcess(env),
    runClipboardCommand: nestedClipboardRunner(env),
    atspi:
      (options.atspiMode ?? "off") === "session"
        ? new AtspiHelperClient({ env })
        : unavailableAtspiReader(),
  };
}

/**
 * Launches apps into the nested session. Mirrors the backend's own default —
 * detached and with no inherited stdio — and only adds the session environment.
 */
export function nestedSpawnProcess(
  env: NodeJS.ProcessEnv,
): (app: string, args: readonly string[]) => ChildProcess {
  return (app, args) =>
    spawn(app, [...args], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ...env },
    });
}

/** wl-clipboard against the nested compositor's own seat rather than seat0. */
export function nestedClipboardRunner(env: NodeJS.ProcessEnv): ClipboardCommandRunner {
  return (spec) => spawnClipboardCommand(spec, env);
}

/**
 * Semantic perception turned off. Reporting no trees is what the backend
 * already handles for an application without accessibility support, so
 * coordinate actions, window listing, and capture stay fully usable.
 */
export function unavailableAtspiReader(): AtspiTreeReader {
  return {
    readTrees: async () => [],
    setText: async () => false,
    dispose: async () => undefined,
  };
}

/** `SYNARA_COMPUTER_NESTED=1` is the only way a nested session is ever booted. */
export function nestedSessionRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SYNARA_COMPUTER_NESTED === "1";
}

export function nestedAtspiMode(env: NodeJS.ProcessEnv = process.env): NestedAtspiMode {
  return env.SYNARA_COMPUTER_NESTED_ATSPI === "1" ? "session" : "off";
}

/**
 * `SYNARA_COMPUTER_NESTED_SIZE` is an operator override, so a typo must neither
 * crash the server nor boot a compositor of some accidental size: anything that
 * is not `WxH` within the supported range is dropped and the default applies.
 */
export function parseNestedSizeEnv(value: string | undefined): NestedSize | undefined {
  const match = value === undefined ? null : NESTED_SIZE_PATTERN.exec(value.trim());
  if (!match?.[1] || !match[2]) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!inNestedDimensionRange(width) || !inNestedDimensionRange(height)) return undefined;
  return { width, height };
}

export interface NestedPluginLoad {
  /**
   * Every loaded Synara plugin, the newest one included. KWin auto-loads each
   * installed version at startup and the oldest registrant wins the
   * `org.synara.ComputerUse` bus name, so an explicit LoadPlugin of the newest
   * both returns `false` (already loaded) and leaves the old build serving. The
   * only reliable order is: unload all of them, then load the one wanted.
   */
  readonly unload: readonly string[];
  readonly load: string;
}

/** `undefined` when no Synara plugin is installed, which is not recoverable. */
export function resolveNestedPluginLoad(options: {
  readonly loaded: readonly string[];
  readonly installed: readonly string[];
}): NestedPluginLoad | undefined {
  const load = newestPluginId(options.installed);
  if (!load) return undefined;
  return { unload: options.loaded.filter(isSynaraPluginId), load };
}

async function loadNestedPlugin(
  dbus: KWinComputerDbus,
  installed: readonly string[],
): Promise<string> {
  const plan = resolveNestedPluginLoad({ loaded: await dbus.listLoadedPluginIds(), installed });
  if (!plan) {
    throw new ComputerBackendError(
      "No installed SynaraComputerUsePluginVn was found for the nested KWin session. " +
        `Build and install it with ${INSTALL_SCRIPT_PATH}.`,
    );
  }
  for (const pluginId of plan.unload) await dbus.unloadPlugin(pluginId);
  if (!(await dbus.loadPlugin(plan.load))) {
    throw new ComputerBackendError(
      `The nested KWin session refused to load ${plan.load}: a KWin plugin only loads into ` +
        `the exact KWin version it was built against. Rebuild it with ${INSTALL_SCRIPT_PATH}.`,
    );
  }
  return plan.load;
}

/** Names which of the two ways the compositor can fail to appear happened. */
function kwinNotReadyError(kwin: NestedProcess, timeoutMs: number): ComputerBackendError {
  const exit = kwin.exitDiagnostic();
  return new ComputerBackendError(
    exit === undefined
      ? `The nested ${KWIN_COMMAND} did not take ${KWIN_SERVICE} within ${timeoutMs} ms.${kwin.diagnostic()}`
      : `The nested ${KWIN_COMMAND} exited before it was ready (${exit}).${kwin.diagnostic()}`,
  );
}

/**
 * The compositor must not inherit the ambient display: with WAYLAND_DISPLAY or
 * DISPLAY set, kwin_wayland can attach to the very session a nested one exists
 * to stay independent of.
 */
function compositorEnv(busAddress: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DBUS_SESSION_BUS_ADDRESS: busAddress };
  delete env.WAYLAND_DISPLAY;
  delete env.DISPLAY;
  return env;
}

function start(
  spawnProcess: NonNullable<NestedKWinSessionOptions["spawnProcess"]>,
  children: NestedProcess[],
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): NestedProcess {
  let child: ChildProcess;
  try {
    child = spawnProcess(command, args, env);
  } catch (error) {
    throw new ComputerBackendError(`${command} could not be started: ${describeError(error)}`, {
      cause: error,
    });
  }
  const supervised = new NestedProcess(command, child);
  children.push(supervised);
  return supervised;
}

/**
 * One supervised child of the nested session. A spawn error or an early exit is
 * recorded instead of thrown, so every wait can fail fast with the process's
 * own diagnostic rather than running to its deadline.
 */
class NestedProcess {
  private readonly stderr: Buffer[] = [];
  private stderrBytes = 0;
  private exited: string | undefined;
  private readonly finished: Promise<void>;

  constructor(
    private readonly command: string,
    private readonly child: ChildProcess,
  ) {
    child.stderr?.on("data", (chunk: Buffer) => this.pushStderr(chunk));
    child.on("error", (error) => {
      this.exited ??= describeError(error);
    });
    this.finished = new Promise<void>((resolve) => {
      child.on("exit", (code, signal) => {
        this.exited ??= `exit code ${code ?? "null"}, signal ${signal ?? "null"}`;
        resolve();
      });
      child.on("error", () => resolve());
    });
    // The process handle must not hold the server's event loop open. The stdio
    // pipes stay referenced until terminate destroys them, because the startup
    // handshake reads them and an unreferenced pipe can lose that race.
    child.unref();
  }

  /** The dbus-daemon prints its address and then serves; only the first line matters. */
  readFirstStdoutLine(timeoutMs: number): Promise<string> {
    const stdout = this.child.stdout;
    if (!stdout) {
      return Promise.reject(new ComputerBackendError(`${this.command} has no stdout to read.`));
    }
    return new Promise<string>((resolve, reject) => {
      let buffered = "";
      const settle = (outcome: () => void) => {
        clearTimeout(timer);
        stdout.off("data", onData);
        this.child.off("exit", onExit);
        this.child.off("error", onExit);
        outcome();
      };
      const onData = (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        const newline = buffered.indexOf("\n");
        if (newline >= 0) settle(() => resolve(buffered.slice(0, newline).trim()));
      };
      const onExit = () => {
        settle(() =>
          reject(
            new ComputerBackendError(
              `${this.command} exited before it printed anything: ${this.exitDiagnostic() ?? "unknown reason"}.${this.diagnostic()}`,
            ),
          ),
        );
      };
      const timer = setTimeout(() => {
        settle(() =>
          reject(
            new ComputerBackendError(
              `${this.command} printed no output within ${timeoutMs} ms.${this.diagnostic()}`,
            ),
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      stdout.on("data", onData);
      this.child.once("exit", onExit);
      this.child.once("error", onExit);
    });
  }

  /** How the process ended, or `undefined` while it is still running. */
  exitDiagnostic(): string | undefined {
    return this.exited;
  }

  /** The tail of stderr, formatted for appending to a failure message. */
  diagnostic(): string {
    const text = Buffer.concat(this.stderr).toString("utf8").trim();
    return text.length > 0 ? ` Last ${this.command} output: ${text}` : "";
  }

  /** Ends the process, escalating to SIGKILL, and releases its pipes. */
  async terminate(): Promise<void> {
    if (this.exited === undefined && !this.child.killed) {
      this.child.kill("SIGTERM");
      const escalation = setTimeout(() => this.child.kill("SIGKILL"), TERMINATE_GRACE_MS);
      escalation.unref?.();
      await this.finished;
      clearTimeout(escalation);
    }
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
  }

  private pushStderr(chunk: Buffer): void {
    this.stderr.push(chunk);
    this.stderrBytes += chunk.byteLength;
    while (this.stderrBytes > MAX_DIAGNOSTIC_BYTES && this.stderr.length > 1) {
      this.stderrBytes -= this.stderr.shift()?.byteLength ?? 0;
    }
  }
}

/**
 * Both nested processes are ordinary children so a signal to the server's
 * process group reaches them too, and both are unref'd so they never keep the
 * server alive. Dispose is what reliably ends them.
 */
function spawnNestedProcess(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): ChildProcess {
  return spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], env });
}

function normalizeNestedSize(size: NestedSize | undefined): NestedSize {
  return {
    width: normalizeNestedDimension(size?.width, DEFAULT_NESTED_WIDTH),
    height: normalizeNestedDimension(size?.height, DEFAULT_NESTED_HEIGHT),
  };
}

function normalizeNestedDimension(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(MIN_NESTED_DIMENSION, Math.min(MAX_NESTED_DIMENSION, Math.floor(value)));
}

function inNestedDimensionRange(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_NESTED_DIMENSION && value <= MAX_NESTED_DIMENSION;
}

/**
 * The socket lives in the shared XDG runtime directory, so the name has to be
 * unique across servers, and across restarts of this one.
 */
function generateSocketName(): string {
  return `synara-nested-${process.pid}-${randomBytes(3).toString("hex")}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
