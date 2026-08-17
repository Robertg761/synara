/**
 * A private KWin this server owns, in one of two modes.
 *
 * A nested session is a dedicated session bus plus a `kwin_wayland` on it.
 * `virtual` is Tier 3: a headless compositor with no display of its own, for CI
 * and headless hosts. `window` is Tier 2 Phase A: the same compositor running as
 * an ordinary Wayland client of the host, so the isolated desktop is a window on
 * a desktop KWin does not otherwise run. Nothing about the desktop backend
 * changes in either mode: the same KWin plugin loads into the private
 * compositor, and `KWinComputerBackend` reaches it through the same D-Bus
 * surface, only pointed at the private bus.
 *
 * Both modes are opt-in and neither is ever a fallback, including for each
 * other — a nested compositor standing in for a broken desktop would hand an
 * agent an invisible screen and report it as healthy, and a virtual compositor
 * standing in for a windowed one would hand the operator an isolated desktop
 * that is nowhere on screen.
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
import {
  describeProcessError,
  spawnSupervisedProcess,
  startSupervisedProcess,
  type SupervisedProcess,
  type SupervisedSpawn,
} from "./supervisedProcess.ts";
import { spawnClipboardCommand, type ClipboardCommandRunner } from "./wlClipboard.ts";

const DBUS_DAEMON_COMMAND = "dbus-daemon";
const KWIN_COMMAND = "kwin_wayland";
const DEFAULT_NESTED_WIDTH = 1_920;
const DEFAULT_NESTED_HEIGHT = 1_080;
const MIN_NESTED_DIMENSION = 64;
const MAX_NESTED_DIMENSION = 16_384;
const BUS_ADDRESS_TIMEOUT_MS = 10_000;
const KWIN_READY_TIMEOUT_MS = 30_000;
const NESTED_SIZE_PATTERN = /^(\d+)x(\d+)$/i;
const INSTALL_SCRIPT_PATH = "apps/server/native/computer-use-kwin/scripts/install-and-load.sh";

export interface NestedSize {
  readonly width: number;
  readonly height: number;
}

/**
 * How the private compositor is displayed.
 *
 * `virtual` has no output a human can see, which is the point on a CI runner or
 * a headless host. `window` nests the compositor inside the host session as an
 * ordinary Wayland client, which is the only difference between the two — the
 * bus, the plugin, the seat, and the backend are identical.
 */
export type NestedSessionMode = "virtual" | "window";

export interface NestedKWinSessionOptions {
  readonly mode?: NestedSessionMode;
  readonly size?: NestedSize;
  /** Wayland socket name; generated per session so two servers cannot collide. */
  readonly socketName?: string;
  readonly readyTimeoutMs?: number;
  /** The server's own environment, injected so tests do not read the host display. */
  readonly hostEnv?: NodeJS.ProcessEnv;
  readonly installedPluginIds?: () => Promise<readonly string[]>;
  /** Replaced in tests, which must never spawn a compositor. */
  readonly spawnProcess?: SupervisedSpawn;
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
  const spawnProcess = options.spawnProcess ?? spawnSupervisedProcess;
  const connectDbus =
    options.connectDbus ?? ((busAddress: string) => createSessionKWinComputerDbus({ busAddress }));
  const waitForBusName = options.waitForBusName ?? waitForSessionBusName;
  const installedPluginIds = options.installedPluginIds ?? (() => scanInstalledPluginIds());
  const mode = options.mode ?? "virtual";
  const hostEnv = options.hostEnv ?? process.env;
  const size = normalizeNestedSize(options.size);
  const waylandDisplay = options.socketName ?? generateSocketName();
  const children: SupervisedProcess[] = [];
  const dispose = async () => {
    // Newest first: the compositor is torn down before the bus it announced
    // itself on, which keeps its exit from racing a dead bus.
    for (const child of children.toReversed()) await child.terminate();
  };

  try {
    if (mode === "window" && !hostEnv.WAYLAND_DISPLAY) {
      throw new ComputerBackendError(
        "A windowed nested session needs a running Wayland session to nest into, and " +
          `WAYLAND_DISPLAY is not set for this server. Start Synara from the desktop session, or ` +
          "use SYNARA_COMPUTER_NESTED=1 for a headless virtual session.",
      );
    }

    const bus = start(
      spawnProcess,
      children,
      DBUS_DAEMON_COMMAND,
      ["--session", "--print-address=1", "--nofork"],
      hostEnv,
    );
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
      compositorArgs(mode, waylandDisplay, size),
      compositorEnv(busAddress, mode, hostEnv),
    );

    const timeoutMs = options.readyTimeoutMs ?? KWIN_READY_TIMEOUT_MS;
    const ready = await waitForBusName({
      busAddress,
      name: KWIN_SERVICE,
      timeoutMs,
      abort: () => kwin.exitDiagnostic() !== undefined,
    });
    if (!ready) throw kwinNotReadyError(kwin, mode, timeoutMs);

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
      : new ComputerBackendError(describeProcessError(error), {
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

/**
 * `SYNARA_COMPUTER_NESTED` is the only way a nested session is ever booted, and
 * it names the mode: `1` for virtual, `window` for windowed. Anything else, a
 * typo included, leaves the real desktop backend in place rather than guessing a
 * mode — booting the wrong one is either an invisible desktop or a window the
 * operator never asked for.
 */
export function nestedSessionMode(
  env: NodeJS.ProcessEnv = process.env,
): NestedSessionMode | undefined {
  switch (env.SYNARA_COMPUTER_NESTED) {
    case "1":
      return "virtual";
    case "window":
      return "window";
    default:
      return undefined;
  }
}

/** The mode as it reads in a failure message an operator has to act on. */
export function nestedModeLabel(mode: NestedSessionMode): string {
  return mode === "window" ? "windowed" : "virtual";
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
function kwinNotReadyError(
  kwin: SupervisedProcess,
  mode: NestedSessionMode,
  timeoutMs: number,
): ComputerBackendError {
  const exit = kwin.exitDiagnostic();
  const nested = `The nested ${KWIN_COMMAND} (${nestedModeLabel(mode)} mode)`;
  return new ComputerBackendError(
    exit === undefined
      ? `${nested} did not take ${KWIN_SERVICE} within ${timeoutMs} ms.${kwin.diagnostic()}`
      : `${nested} exited before it was ready (${exit}).${kwin.diagnostic()}`,
  );
}

/** `--virtual` is the whole difference: without it the compositor nests as a client. */
function compositorArgs(
  mode: NestedSessionMode,
  socketName: string,
  size: NestedSize,
): readonly string[] {
  return [
    ...(mode === "virtual" ? ["--virtual"] : []),
    "--no-global-shortcuts",
    "--socket",
    socketName,
    "--width",
    String(size.width),
    "--height",
    String(size.height),
  ];
}

/**
 * A virtual compositor must not inherit the ambient display: with
 * WAYLAND_DISPLAY or DISPLAY set, kwin_wayland can attach to the very session a
 * nested one exists to stay independent of. A windowed one is the exact
 * opposite — the host WAYLAND_DISPLAY is the socket it nests through, and
 * without it there is no window. DISPLAY goes in both modes, because an X11
 * attach is never what either was asked for.
 */
function compositorEnv(
  busAddress: string,
  mode: NestedSessionMode,
  hostEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...hostEnv, DBUS_SESSION_BUS_ADDRESS: busAddress };
  if (mode === "virtual") delete env.WAYLAND_DISPLAY;
  delete env.DISPLAY;
  return env;
}

/**
 * Starts one child and registers it for disposal. Both nested processes are
 * ordinary children so a signal to the server's process group reaches them too,
 * and both are unref'd so they never keep the server alive. Dispose is what
 * reliably ends them.
 */
function start(
  spawnProcess: NonNullable<NestedKWinSessionOptions["spawnProcess"]>,
  children: SupervisedProcess[],
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): SupervisedProcess {
  const supervised = startSupervisedProcess({ command, args, env, spawnProcess });
  children.push(supervised);
  return supervised;
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
