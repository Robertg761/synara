/**
 * Window enumeration on GNOME, through the Synara GNOME Shell extension.
 *
 * GNOME is the one desktop in the Tier 2 set where no protocol answers "what
 * windows exist and where are they". mutter implements no foreign-toplevel
 * protocol, a Wayland client can see only its own surfaces, and AT-SPI extents
 * are frame-relative, so they cannot say where the frame is. Everything else —
 * input, capture, clipboard — has a portal. Windows have nothing.
 *
 * So this provider talks to code running *inside* GNOME Shell:
 * `synara-computer-use@synara.dev` (source in
 * `apps/server/native/gnome-shell-extension`), which owns
 * `org.synara.ComputerUse` on the session bus and answers with the same window
 * document Synara's KWin plugin emits. That is why the translation here is a
 * call to the shared `parseWindows` rather than a second parser: an agent's
 * coordinates have to mean the same thing on GNOME as they do on KDE, and two
 * parsers is how they stop meaning the same thing.
 *
 * Unlike the wlroots provider, this one reports geometry and stacking, so
 * `providesBounds` and `providesStacking` are both true and window-scoped
 * capture and targeting work on GNOME.
 *
 * Every way this can fail refuses with a sentence naming the extension and what
 * to do about it — never with an empty list, which is indistinguishable from an
 * empty desktop and is the failure that had an agent relaunch the same
 * application until its turn ended.
 */
import { createRequire } from "node:module";
import type { EventEmitter } from "node:events";

import type dbusModule from "dbus-next";
import type { ComputerWindow } from "@synara/contracts";

import { ComputerBackendError } from "../ComputerBackend.ts";
import { parseWindows, unwrapDbusValue } from "../computerGeometry.ts";
import { withDbusTimeout } from "../dbusPlumbing.ts";
import {
  COMPUTER_INTERFACE,
  COMPUTER_OBJECT_PATH,
  KWIN_DBUS_DEFAULT_TIMEOUT_MS,
  invokeKWinDbusMethod,
} from "../kwinDbus.ts";
import { SYNARA_DESKTOP_EXTENSION_BUS_NAME } from "./probe.ts";
import type { PortalProviderId, PortalWindowProvider } from "./providers.ts";

/** The extension's UUID, which is also its directory name. */
export const GNOME_EXTENSION_UUID = "synara-computer-use@synara.dev";
/** Where the extension is shipped from, named verbatim in every refusal. */
export const GNOME_EXTENSION_SOURCE_PATH =
  "apps/server/native/gnome-shell-extension/synara-computer-use@synara.dev";
/**
 * Bus address of the extension.
 *
 * Deliberately the same name, path, and interface the KWin plugin owns: one
 * desktop-side component per desktop, one address, one window document. The two
 * never run in the same session — KWin's presence is what selects Tier 1 — and
 * `Version()` distinguishes them for the case where a KDE host is forced into
 * Tier 2 by an override.
 */
export const GNOME_EXTENSION_BUS_NAME = SYNARA_DESKTOP_EXTENSION_BUS_NAME;
export const GNOME_EXTENSION_OBJECT_PATH = COMPUTER_OBJECT_PATH;
export const GNOME_EXTENSION_INTERFACE = COMPUTER_INTERFACE;

/**
 * The window protocol this build speaks.
 *
 * A version the server does not know is refused rather than guessed at: the
 * document carries the coordinates every click is aimed with, and a field that
 * quietly changed meaning is how a click lands on the wrong monitor.
 */
export const GNOME_EXTENSION_PROTOCOL_VERSION = 1;

/**
 * The extension's five methods, as plain promises.
 *
 * The seam the tests use. Everything above this line is translation and
 * refusal, which is the part worth testing; everything below it is dbus-next.
 */
export interface GnomeShellComputerUseApi {
  version(): Promise<unknown>;
  listWindows(): Promise<unknown>;
  activateWindow(windowId: string): Promise<unknown>;
  raiseWindow(windowId: string): Promise<unknown>;
}

export interface GnomeShellExtensionConnection {
  readonly api: GnomeShellComputerUseApi;
  close(): Promise<void>;
}

/** Opens a connection to the extension, or rejects saying why it could not. */
export type GnomeShellExtensionConnect = () => Promise<GnomeShellExtensionConnection>;

export interface GnomeShellWindowProviderOptions {
  readonly connect: GnomeShellExtensionConnect;
  /** Overridden only by tests pinning the mismatch copy. */
  readonly expectedProtocolVersion?: number;
}

export class GnomeShellWindowProvider implements PortalWindowProvider {
  readonly id: PortalProviderId = "gnome-shell-extension";
  /** The extension reports `get_frame_rect()`, in the desktop coordinate space. */
  readonly providesBounds = true;
  /** It walks mutter's stacking order, so depth and occlusion are real. */
  readonly providesStacking = true;

  private readonly connect: GnomeShellExtensionConnect;
  private readonly expectedVersion: number;
  /**
   * The live connection, established on first use and kept.
   *
   * Lazy because construction happens at backend startup on a desktop where the
   * extension may not be installed, and a probe-time bus name check has already
   * decided whether it is worth trying; a failed handshake here would be a
   * second, noisier answer to the same question. A *failure* is not cached: the
   * user may install the extension, or unlock the screen (GNOME disables
   * extensions while locked), and the next call should find it.
   */
  private connection: Promise<GnomeShellExtensionConnection> | undefined;
  private disposed = false;

  constructor(options: GnomeShellWindowProviderOptions) {
    this.connect = options.connect;
    this.expectedVersion = options.expectedProtocolVersion ?? GNOME_EXTENSION_PROTOCOL_VERSION;
  }

  async listWindows(): Promise<readonly ComputerWindow[]> {
    const api = await this.service();
    const payload = await this.call(api.listWindows(), "list the windows");
    return translateWindows(payload);
  }

  async activateWindow(windowId: string): Promise<void> {
    const api = await this.service();
    await this.call(api.activateWindow(windowId), `activate window ${JSON.stringify(windowId)}`);
  }

  /**
   * Restack without focus. Present here and absent on the wlroots provider
   * because mutter can actually do it — which is what makes a click on a
   * covered window possible on GNOME without taking the human's focus.
   */
  async raiseWindow(windowId: string): Promise<void> {
    const api = await this.service();
    await this.call(api.raiseWindow(windowId), `raise window ${JSON.stringify(windowId)}`);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const pending = this.connection;
    this.connection = undefined;
    if (!pending) return;
    try {
      const connection = await pending;
      await connection.close();
    } catch {
      // A connection that never opened, or died on its own, needs no closing.
    }
  }

  /**
   * The connected extension, version-checked exactly once per connection.
   *
   * The handshake is part of connecting rather than a separate step, so no
   * caller can reach a service whose protocol was never verified.
   */
  private async service(): Promise<GnomeShellComputerUseApi> {
    if (this.disposed) {
      throw new ComputerBackendError("The GNOME Shell window provider has been disposed.");
    }
    this.connection ??= this.openAndVerify();
    try {
      const connection = await this.connection;
      return connection.api;
    } catch (error) {
      this.connection = undefined;
      throw error;
    }
  }

  private async openAndVerify(): Promise<GnomeShellExtensionConnection> {
    let connection: GnomeShellExtensionConnection;
    try {
      connection = await this.connect();
    } catch (error) {
      throw unreachable(describe(error), error);
    }

    let reported: unknown;
    try {
      reported = await connection.api.version();
    } catch (error) {
      await closeQuietly(connection);
      throw new ComputerBackendError(
        `Something owns ${GNOME_EXTENSION_BUS_NAME} on this session bus but did not answer ${GNOME_EXTENSION_INTERFACE}.Version() (${describe(error)}), ` +
          `so Synara cannot tell whether it is the ${GNOME_EXTENSION_UUID} GNOME Shell extension. ` +
          `Reinstall the extension from ${GNOME_EXTENSION_SOURCE_PATH} and log out and back in. ` +
          "On KDE, Synara's KWin plugin owns the same bus name and speaks a different API — that host belongs on the KWin backend, not the portal one.",
        { retryable: false, cause: error },
      );
    }

    const version = unwrapDbusValue(reported);
    if (typeof version !== "number" || !Number.isInteger(version)) {
      await closeQuietly(connection);
      throw new ComputerBackendError(
        `The ${GNOME_EXTENSION_UUID} GNOME Shell extension answered Version() with ${JSON.stringify(version)} rather than a protocol version number, ` +
          `so its window document cannot be trusted. Update the extension: reinstall it from ${GNOME_EXTENSION_SOURCE_PATH} and log out and back in.`,
        { retryable: false },
      );
    }
    if (version !== this.expectedVersion) {
      await closeQuietly(connection);
      throw new ComputerBackendError(
        `The installed ${GNOME_EXTENSION_UUID} GNOME Shell extension speaks window protocol version ${version}, and this build of Synara speaks ${this.expectedVersion}. ` +
          `Update the extension: reinstall it from ${GNOME_EXTENSION_SOURCE_PATH} (run its install.sh) and log out and back in.` +
          (version > this.expectedVersion
            ? " The installed extension is newer than this server, so updating Synara is the other way to close the gap."
            : ""),
        { retryable: false },
      );
    }
    return connection;
  }

  /**
   * One extension call, with its failure turned into a refusal that says which
   * operation failed and keeps the extension's own sentence.
   *
   * Non-retryable: the extension answers from inside the compositor with no
   * queue and no backpressure, so a failure is a missing window, a mutter API
   * that is gone, or an extension that has been disabled — none of which the
   * next identical call fixes.
   */
  private async call(pending: Promise<unknown>, attempted: string): Promise<unknown> {
    try {
      return await pending;
    } catch (error) {
      // The connection may be the thing that died; drop it so the next call
      // reconnects rather than failing forever against a dead proxy. It is
      // closed, not merely dropped: a stale window id is a routine failure, and
      // leaking one bus socket per refusal adds up. A concurrent call sharing
      // the connection loses it too, which costs one honest refusal and a
      // reconnect — cheaper than the leak.
      const dropped = this.connection;
      this.connection = undefined;
      if (dropped) {
        void dropped.then((connection) => closeQuietly(connection)).catch(() => undefined);
      }
      throw new ComputerBackendError(
        `The ${GNOME_EXTENSION_UUID} GNOME Shell extension could not ${attempted}: ${describe(error)}`,
        { retryable: false, cause: error },
      );
    }
  }
}

/**
 * The extension's JSON document, as `ComputerWindow`s.
 *
 * `parseWindows` is the KWin path's parser, used verbatim on purpose: the two
 * desktop-side components emit the same document, and a second parser is how
 * the same field quietly starts meaning two things.
 *
 * Malformed input refuses rather than degrading to `[]`. `parseWindows` drops
 * an unusable entry by design — a window with no id or no rect cannot be
 * addressed — but a non-empty document where *nothing* survived is a broken
 * extension, not an empty desktop, and the two must not look alike.
 *
 * `ComputerWindow.focused` is forced false on this provider, and that is a
 * privacy decision rather than a simplification. Across this stack `focused`
 * means *the agent seat's input target*: the KWin backend derives it only from
 * the agent seat's target window, and `ComputerManager.focusedCapturableWindow`
 * relies on that meaning for its `agentFocusOnly` guard, which stops post-action
 * observation from photographing whatever the human is working in. The portal
 * backend has no agent seat — input joins the human's — so no window is ever the
 * agent's focus target here. mutter's `has_focus()` is the human's keyboard
 * focus and is reported as `active`, which is the field that means that
 * everywhere. Overwritten rather than trusted: an older extension that still
 * sends `focused: true` must not be able to reintroduce the leak.
 */
function translateWindows(payload: unknown): readonly ComputerWindow[] {
  const raw = unwrapDbusValue(payload);
  if (typeof raw !== "string") {
    throw malformed(`ListWindows() answered with ${typeof raw} rather than a JSON string`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw malformed(`ListWindows() answered with text that is not JSON (${describe(error)})`);
  }
  if (!Array.isArray(parsed)) {
    throw malformed("ListWindows() answered with a JSON document that is not an array of windows");
  }
  const windows = parseWindows(parsed.map(withoutAgentFocus), null);
  if (parsed.length > 0 && windows.length === 0) {
    throw malformed(
      `ListWindows() reported ${parsed.length} window(s), none of which carried a usable id and rect`,
    );
  }
  return windows;
}

/** See `translateWindows`: there is no agent-seat focus on the portal backend. */
function withoutAgentFocus(entry: unknown): unknown {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
  return { ...(entry as Record<string, unknown>), focused: false };
}

function unreachable(detail: string, cause?: unknown): ComputerBackendError {
  return new ComputerBackendError(
    `The ${GNOME_EXTENSION_UUID} GNOME Shell extension is not answering on ${GNOME_EXTENSION_BUS_NAME} (${detail}), ` +
      "and GNOME exposes no other way to enumerate windows. " +
      `Install it from ${GNOME_EXTENSION_SOURCE_PATH} into ~/.local/share/gnome-shell/extensions/${GNOME_EXTENSION_UUID}, ` +
      `enable it with \`gnome-extensions enable ${GNOME_EXTENSION_UUID}\`, and log out and back in — GNOME cannot reload extensions on Wayland. ` +
      "GNOME also disables extensions while the screen is locked, which looks identical from here.",
    { retryable: false, ...(cause === undefined ? {} : { cause }) },
  );
}

function malformed(detail: string): ComputerBackendError {
  return new ComputerBackendError(
    `The ${GNOME_EXTENSION_UUID} GNOME Shell extension returned a window list Synara could not read: ${detail}. ` +
      `Update the extension: reinstall it from ${GNOME_EXTENSION_SOURCE_PATH} and log out and back in.`,
    { retryable: false },
  );
}

async function closeQuietly(connection: GnomeShellExtensionConnection): Promise<void> {
  try {
    await connection.close();
  } catch {
    // Closing a connection that is already gone is not a second failure.
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The production connection: one dbus-next proxy on the session bus.
 *
 * Kept in this module rather than shared with `portalBus.ts` because the
 * extension is an ordinary D-Bus service — no `Request` objects, no `Response`
 * signals, no file descriptors — so the proxy API dbus-next was designed around
 * fits it exactly, which is not true of the portals.
 */
export async function connectGnomeShellExtension(
  options: { readonly busAddress?: string } = {},
): Promise<GnomeShellExtensionConnection> {
  // Keep the optional Linux runtime out of test imports; this resolves only on
  // the production path, after the platform gate.
  const require = createRequire(import.meta.url);
  const dbus = require("dbus-next") as typeof dbusModule;
  const bus = options.busAddress
    ? dbus.sessionBus({ busAddress: options.busAddress })
    : dbus.sessionBus();
  const eventBus = bus as unknown as EventEmitter;
  // dbus-next emits connection failures on the bus object, and an unhandled
  // `error` event takes the whole server down. The listener is the difference
  // between "the extension is not installed" and a dead process.
  let connectionError: unknown;
  const onError = (error: unknown) => {
    connectionError ??= error;
  };
  eventBus.on("error", onError);
  eventBus.on("disconnect", onError);

  try {
    const object = await withTimeout(
      Promise.resolve(bus.getProxyObject(GNOME_EXTENSION_BUS_NAME, GNOME_EXTENSION_OBJECT_PATH)),
      "getProxyObject",
    );
    const iface = object.getInterface(GNOME_EXTENSION_INTERFACE);
    return {
      api: {
        version: () => invokeKWinDbusMethod(iface, "Version"),
        listWindows: () => invokeKWinDbusMethod(iface, "ListWindows"),
        activateWindow: (windowId) => invokeKWinDbusMethod(iface, "ActivateWindow", windowId),
        raiseWindow: (windowId) => invokeKWinDbusMethod(iface, "RaiseWindow", windowId),
      },
      close: () => {
        eventBus.off("error", onError);
        eventBus.off("disconnect", onError);
        bus.disconnect();
        return Promise.resolve();
      },
    };
  } catch (error) {
    eventBus.off("error", onError);
    eventBus.off("disconnect", onError);
    bus.disconnect();
    throw asError(connectionError ?? error);
  }
}

/**
 * A plain `Error` on purpose: the only caller catches it and rewrites it into
 * the `ComputerBackendError` that names the extension, so a richer type here
 * would be discarded. `asError` is still applied to a reported failure, because
 * dbus-next can reject with a non-Error and that caller reads `.message`.
 */
function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return withDbusTimeout(promise, KWIN_DBUS_DEFAULT_TIMEOUT_MS, {
    onTimeout: () => new Error(`${label} timed out after ${KWIN_DBUS_DEFAULT_TIMEOUT_MS} ms`),
    onRejected: asError,
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
