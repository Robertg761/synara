import { createRequire } from "node:module";
import type { EventEmitter } from "node:events";

import type dbusModule from "dbus-next";

export const KWIN_SERVICE = "org.kde.KWin";
export const KWIN_PLUGINS_PATH = "/Plugins";
export const KWIN_PLUGINS_INTERFACE = "org.kde.KWin.Plugins";
export const DBUS_PROPERTIES_INTERFACE = "org.freedesktop.DBus.Properties";
export const DBUS_SERVICE = "org.freedesktop.DBus";
export const DBUS_OBJECT_PATH = "/org/freedesktop/DBus";
export const DBUS_INTERFACE = "org.freedesktop.DBus";
export const COMPUTER_SERVICE = "org.synara.ComputerUse";
export const COMPUTER_OBJECT_PATH = "/org/synara/ComputerUse";
export const COMPUTER_INTERFACE = "org.synara.ComputerUse1";
export const KWIN_DBUS_DEFAULT_TIMEOUT_MS = 5_000;
export const KWIN_DBUS_CAPTURE_TIMEOUT_MS = 10_000;
const DBUS_NAME_POLL_MS = 100;

export class KWinDbusTimeoutError extends Error {
  readonly connectionLevel = true;
  readonly methodName: string;
  readonly timeoutMs: number;

  constructor(methodName: string, timeoutMs: number) {
    super(`D-Bus call ${methodName} timed out after ${timeoutMs} ms.`);
    this.name = "KWinDbusTimeoutError";
    this.methodName = methodName;
    this.timeoutMs = timeoutMs;
  }
}

export interface KWinComputerPluginApi {
  readonly healthJson: () => Promise<unknown>;
  readonly stateJson: () => Promise<unknown>;
  readonly windowsJson: () => Promise<unknown>;
  readonly start: () => Promise<unknown>;
  readonly stop: () => Promise<unknown>;
  readonly setIdleTimeout: (milliseconds: number) => Promise<unknown>;
  /**
   * How recently the human's own seat must have been active for the plugin to
   * refuse a mutating action aimed at the window they are focused on. `0`
   * disables the guard. Absent on plugin builds older than Phase 4.
   */
  readonly setHumanActiveGuardMs: (milliseconds: number) => Promise<unknown>;
  /** Names the thread driving the ghost cursor, for the on-screen badge. */
  readonly setAgentName: (name: string) => Promise<unknown>;
  readonly focusWindow: (windowId: string) => Promise<unknown>;
  readonly raiseWindow: (windowId: string) => Promise<unknown>;
  readonly clearFocusWindow: () => Promise<unknown>;
  readonly movePointer: (x: number, y: number) => Promise<unknown>;
  readonly button: (code: number, pressed: boolean) => Promise<unknown>;
  /**
   * Scroll distance in logical pixels on each axis, the same unit as pointer
   * coordinates and window bounds — not wheel notches or lines. One unit is one
   * pixel of content, so a wheel notch is on the order of a hundred. The plugin
   * consumes the same unit, and the agent tool surface documents it, so a delta
   * means the same thing at every hop.
   */
  readonly axis: (horizontal: number, vertical: number) => Promise<unknown>;
  readonly key: (code: number, pressed: boolean) => Promise<unknown>;
  readonly captureWindow: (windowId: string, maxDimension: number) => Promise<unknown>;
  readonly captureRegion: (
    x: number,
    y: number,
    width: number,
    height: number,
    maxDimension: number,
  ) => Promise<unknown>;
}

export interface KWinComputerDbus {
  readonly listLoadedPluginIds: () => Promise<readonly string[]>;
  readonly loadPlugin: (pluginId: string) => Promise<boolean>;
  /** `false` only when KWin reports the id was not loaded to begin with. */
  readonly unloadPlugin: (pluginId: string) => Promise<boolean>;
  readonly connectPlugin: () => Promise<KWinComputerPluginApi>;
  readonly onDisconnect: (listener: () => void) => () => void;
  readonly close: () => Promise<void>;
}

export interface KWinComputerDbusOptions {
  /**
   * A private bus to use instead of the ambient session bus, as the nested
   * Tier 3 compositor runs on one. Absent, this is the user's own session bus,
   * which is the only bus a real desktop's KWin is reachable on.
   */
  readonly busAddress?: string;
}

/**
 * Connect to a session bus and KWin's plugin manager.
 *
 * The plugin proxy is resolved only after the backend has selected and loaded
 * an installed plugin. This matters because KWin does not own the Synara
 * service until the plugin has been loaded.
 */
export async function createSessionKWinComputerDbus(
  options: KWinComputerDbusOptions = {},
): Promise<KWinComputerDbus> {
  // Keep the optional Linux runtime out of test imports. The production path
  // resolves it only when the backend has passed the Linux/Wayland gate.
  const require = createRequire(import.meta.url);
  const dbus = require("dbus-next") as typeof dbusModule;
  const bus = options.busAddress
    ? dbus.sessionBus({ busAddress: options.busAddress })
    : dbus.sessionBus();
  let closed = false;
  const disconnectListeners = new Set<() => void>();
  const onDisconnectEvent = () => {
    for (const listener of disconnectListeners) listener();
  };
  const eventBus = bus as unknown as EventEmitter;
  eventBus.on("disconnect", onDisconnectEvent);
  eventBus.on("error", onDisconnectEvent);

  try {
    const pluginsObject = await withTimeout(
      Promise.resolve(bus.getProxyObject(KWIN_SERVICE, KWIN_PLUGINS_PATH)),
      KWIN_DBUS_DEFAULT_TIMEOUT_MS,
      "getProxyObject",
    );
    const plugins = pluginsObject.getInterface(KWIN_PLUGINS_INTERFACE);
    // KWin exposes the loaded plugin list as the LoadedPlugins property (KWin 6
    // has no loadedPlugins method); keep the method as a fallback for variants
    // that only offer it.
    let properties: unknown;
    try {
      properties = pluginsObject.getInterface(DBUS_PROPERTIES_INTERFACE);
    } catch {
      properties = undefined;
    }
    return {
      listLoadedPluginIds: async () => {
        const result = properties
          ? await invoke(properties, "Get", KWIN_PLUGINS_INTERFACE, "LoadedPlugins")
          : await invoke(plugins, "loadedPlugins");
        return readStringArray(result);
      },
      loadPlugin: async (pluginId) => {
        const result = await invoke(plugins, "LoadPlugin", pluginId);
        return readBoolean(result);
      },
      unloadPlugin: async (pluginId) => {
        // KWin's UnloadPlugin reply differs by version: older builds answer
        // `b`, newer ones are void. A void reply means the call succeeded, so
        // only an explicit `false` reports "was not loaded".
        const result = await invoke(plugins, "UnloadPlugin", pluginId);
        return readOptionalBoolean(result) ?? true;
      },
      connectPlugin: async () => {
        const object = await withTimeout(
          Promise.resolve(bus.getProxyObject(COMPUTER_SERVICE, COMPUTER_OBJECT_PATH)),
          KWIN_DBUS_DEFAULT_TIMEOUT_MS,
          "getProxyObject",
        );
        const plugin = object.getInterface(COMPUTER_INTERFACE);
        return makePluginApi(plugin);
      },
      onDisconnect: (listener) => {
        disconnectListeners.add(listener);
        return () => disconnectListeners.delete(listener);
      },
      close: async () => {
        if (closed) return;
        closed = true;
        disconnectListeners.clear();
        eventBus.off("disconnect", onDisconnectEvent);
        eventBus.off("error", onDisconnectEvent);
        bus.disconnect();
      },
    };
  } catch (error) {
    eventBus.off("disconnect", onDisconnectEvent);
    eventBus.off("error", onDisconnectEvent);
    bus.disconnect();
    throw error;
  }
}

/**
 * Waits for `name` to be owned on a bus, and reports whether it appeared.
 *
 * One connection polls `NameHasOwner` rather than reconnecting per attempt: a
 * connect/disconnect cycle per poll would churn the bus, and a failed connect
 * can emit a late error on a bus nobody is listening to any more.
 */
export async function waitForSessionBusName(options: {
  readonly busAddress: string;
  readonly name: string;
  readonly timeoutMs: number;
  readonly pollMs?: number;
  /** Ends the wait early, for a caller that knows the name will never appear. */
  readonly abort?: () => boolean;
}): Promise<boolean> {
  const require = createRequire(import.meta.url);
  const dbus = require("dbus-next") as typeof dbusModule;
  const bus = dbus.sessionBus({ busAddress: options.busAddress });
  const eventBus = bus as unknown as EventEmitter;
  let connectionError: unknown;
  const onError = (error: unknown) => {
    connectionError ??= error;
  };
  eventBus.on("error", onError);
  eventBus.on("disconnect", onError);
  try {
    const daemon = await withTimeout(
      Promise.resolve(bus.getProxyObject(DBUS_SERVICE, DBUS_OBJECT_PATH)),
      KWIN_DBUS_DEFAULT_TIMEOUT_MS,
      "getProxyObject",
    );
    const iface = daemon.getInterface(DBUS_INTERFACE);
    const deadline = Date.now() + options.timeoutMs;
    for (;;) {
      if (options.abort?.() === true) return false;
      if (connectionError !== undefined) throw connectionError;
      if ((await invoke(iface, "NameHasOwner", options.name)) === true) return true;
      if (Date.now() >= deadline) return false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, options.pollMs ?? DBUS_NAME_POLL_MS);
        timer.unref?.();
      });
    }
  } finally {
    eventBus.off("error", onError);
    eventBus.off("disconnect", onError);
    bus.disconnect();
  }
}

function makePluginApi(iface: unknown): KWinComputerPluginApi {
  return {
    healthJson: () => invoke(iface, "healthJson"),
    stateJson: () => invoke(iface, "stateJson"),
    windowsJson: () => invoke(iface, "windowsJson"),
    start: () => invoke(iface, "start"),
    stop: () => invoke(iface, "stop"),
    setIdleTimeout: (milliseconds) => invoke(iface, "setIdleTimeout", milliseconds),
    setHumanActiveGuardMs: (milliseconds) => invoke(iface, "setHumanActiveGuardMs", milliseconds),
    setAgentName: (name) => invoke(iface, "setAgentName", name),
    focusWindow: (windowId) => invoke(iface, "focusWindow", windowId),
    raiseWindow: (windowId) => invoke(iface, "raiseWindow", windowId),
    clearFocusWindow: () => invoke(iface, "clearFocusWindow"),
    movePointer: (x, y) => invoke(iface, "movePointer", x, y),
    button: (code, pressed) => invoke(iface, "button", code, pressed),
    axis: (horizontal, vertical) => invoke(iface, "axis", horizontal, vertical),
    key: (code, pressed) => invoke(iface, "key", code, pressed),
    captureWindow: (windowId, maxDimension) =>
      invoke(iface, "captureWindow", windowId, maxDimension),
    captureRegion: (x, y, width, height, maxDimension) =>
      invoke(iface, "captureRegion", x, y, width, height, maxDimension),
  };
}

export async function invokeKWinDbusMethod(
  iface: unknown,
  methodName: string,
  ...args: readonly unknown[]
): Promise<unknown> {
  if (typeof iface !== "object" || iface === null) {
    throw new Error(`D-Bus interface ${methodName} is unavailable.`);
  }
  const method = (iface as Record<string, unknown>)[methodName];
  if (typeof method !== "function") {
    throw new Error(`D-Bus method ${methodName} is unavailable.`);
  }
  const result = (method as (...callArgs: readonly unknown[]) => Promise<unknown>)(...args);
  return await withTimeout(
    Promise.resolve(result),
    isCaptureMethod(methodName) ? KWIN_DBUS_CAPTURE_TIMEOUT_MS : KWIN_DBUS_DEFAULT_TIMEOUT_MS,
    methodName,
  );
}

const invoke = invokeKWinDbusMethod;

function unwrapDbusValue(value: unknown): unknown {
  if (isDbusVariant(value)) {
    return unwrapDbusValue((value as { readonly value: unknown }).value);
  }
  return value;
}

function isDbusVariant(
  value: unknown,
): value is { readonly signature: string; readonly value: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly signature?: unknown }).signature === "string" &&
    "value" in value
  );
}

function isCaptureMethod(methodName: string): boolean {
  return methodName === "captureWindow" || methodName === "captureRegion";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, methodName: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new KWinDbusTimeoutError(methodName, timeoutMs));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function readBoolean(value: unknown): boolean {
  const unwrapped = unwrapDbusValue(value);
  if (typeof unwrapped !== "boolean") {
    throw new Error("KWin returned a non-boolean plugin result.");
  }
  return unwrapped;
}

/** `undefined` for the void reply a KWin build without a return value sends. */
export function readOptionalBoolean(value: unknown): boolean | undefined {
  const unwrapped = unwrapDbusValue(value);
  return typeof unwrapped === "boolean" ? unwrapped : undefined;
}

export function readStringArray(value: unknown): readonly string[] {
  const unwrapped = unwrapDbusValue(value);
  if (!Array.isArray(unwrapped) || !unwrapped.every((item) => typeof item === "string")) {
    throw new Error("KWin returned an invalid loaded plugin list.");
  }
  return unwrapped;
}
