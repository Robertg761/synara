/**
 * One granted portal session, and everything that has to be true for it to exist.
 *
 * On GNOME there is no unprivileged input protocol and no unprivileged capture
 * protocol. Both go through `org.freedesktop.portal.Desktop`, and both are
 * gated on a dialog the user has to answer. That makes the session, not the
 * provider, the real unit of Tier 2 on this desktop: input, capture, and
 * clipboard are three faces of one grant, they live and die together, and each
 * of them separately would raise its own dialog if it opened its own session.
 *
 * The single most important structural decision here is that RemoteDesktop and
 * ScreenCast are **joined on one session handle**. `SelectSources` is called on
 * the same handle `CreateSession` produced on RemoteDesktop, so `Start` returns
 * both the device grant and the stream list. That is not an optimization
 * either: `NotifyPointerMotionAbsolute` takes a *stream* and coordinates
 * relative to it, so without a joined ScreenCast session there is no coordinate
 * space to point at and the only motion available is relative — which cannot
 * implement "click this button at (x, y)". A separate ScreenCast session would
 * also mean two dialogs for one feature.
 *
 * The other decision worth stating is that the session is opened lazily, on the
 * first action that needs it, and never at boot or at probe time. A consent
 * dialog that appears because a server started is a dialog with no context, and
 * the honest moment to ask is when an agent actually tries to touch the screen.
 *
 * Kill switch: the portal destroys the session when the D-Bus connection drops,
 * so `close()` genuinely stops input at the compositor rather than asking a
 * layer of our own code to stop sending. The `Closed` signal is the same thing
 * in the other direction — the user hit Stop, or the screen locked — and it
 * puts consent back to `not-requested` so the next action asks again instead of
 * silently doing nothing.
 */
import type { ComputerPoint, ComputerRect } from "@synara/contracts";

import { ComputerBackendError } from "../ComputerBackend.ts";
import {
  connectSessionPortalBus,
  portalBoolean,
  portalHandleToken,
  portalString,
  portalStringArray,
  portalUint32,
  type PortalBus,
  type PortalOptions,
} from "./portalBus.ts";
import {
  callPortalRequest,
  PORTAL_BUS_NAME,
  PORTAL_OBJECT_PATH,
  PORTAL_RESPONSE_CANCELLED,
  PORTAL_RESPONSE_SUCCESS,
  PORTAL_SESSION_INTERFACE,
  unwrapVariant,
  variantBoolean,
  variantNumber,
  variantString,
} from "./portalRequest.ts";
import {
  PORTAL_REMOTE_DESKTOP_INTERFACE,
  PORTAL_SCREENCAST_INTERFACE,
  REMOTE_DESKTOP_DEVICE_KEYBOARD,
  REMOTE_DESKTOP_DEVICE_POINTER,
} from "./probe.ts";
import {
  portalRestoreKey,
  type PortalRestoreTokenStore,
  inMemoryRestoreTokenStore,
} from "./restoreTokenStore.ts";

export const PORTAL_CLIPBOARD_INTERFACE = "org.freedesktop.portal.Clipboard";

/** `SelectSources` source types. Only monitors give a desktop coordinate space. */
const SCREENCAST_SOURCE_MONITOR = 1;
/**
 * `cursor_mode: metadata` keeps the pointer out of the pixels and delivers its
 * position as stream metadata instead. Embedding it would put a cursor in every
 * screenshot the agent reasons about, and the agent's own pointer moving through
 * its own screenshots is a reliable way to make it click on itself.
 */
const SCREENCAST_CURSOR_MODE_METADATA = 4;
/** `persist_mode: 2` — remember this grant across restarts, subject to a token. */
const PORTAL_PERSIST_MODE_PERSISTENT = 2;

const POINTER_BUTTON_RELEASED = 0;
const POINTER_BUTTON_PRESSED = 1;
const POINTER_AXIS_VERTICAL = 0;
const POINTER_AXIS_HORIZONTAL = 1;

/** The clipboard interface arrived with RemoteDesktop v2; v1 portals have none. */
export const PORTAL_CLIPBOARD_MINIMUM_REMOTE_DESKTOP_VERSION = 2;

export type PortalSessionConsent = "not-requested" | "awaiting" | "granted" | "denied";

export interface PortalStream {
  /** The PipeWire node id, and the handle `NotifyPointerMotionAbsolute` takes. */
  readonly nodeId: number;
  /**
   * Where this stream sits in the desktop's coordinate space. Optional because
   * the portal only reports `position` for monitor sources, and a stream
   * without one cannot be pointed at absolutely — which is a refusal, not a
   * guess.
   */
  readonly rect?: ComputerRect;
}

export interface PortalSessionState {
  readonly sessionHandle: string;
  /** The device types actually granted, which can be narrower than requested. */
  readonly devices: number;
  readonly streams: readonly PortalStream[];
  readonly clipboardEnabled: boolean;
}

export interface PortalSessionOptions {
  /** Test seam and lazy-connect seam in one: nothing dials the bus until asked. */
  readonly connect?: () => Promise<PortalBus>;
  /** Bitmask of `REMOTE_DESKTOP_DEVICE_*`. */
  readonly deviceTypes?: number;
  /** The devices the portal says exist, from the probe. Requests are narrowed to it. */
  readonly availableDeviceTypes?: number;
  /** Join a ScreenCast session, which is what makes absolute pointing possible. */
  readonly withScreenCast?: boolean;
  readonly remoteDesktopVersion?: number;
  /** Ask for the clipboard interface. Silently unavailable below RemoteDesktop v2. */
  readonly withClipboard?: boolean;
  /** Names the restore-token entry, so a grant is not replayed onto another desktop. */
  readonly desktop?: string;
  readonly restoreTokens?: PortalRestoreTokenStore;
  readonly onConsentChanged?: (state: PortalSessionConsent, reason?: string) => void;
  /**
   * How long to wait for `Start`. Undefined by default and deliberately so: the
   * dialog is blocked on a human, and a timeout would tear it down while they
   * were reading it.
   */
  readonly startTimeoutMs?: number;
}

/**
 * A refusal that names the portal step that produced it.
 *
 * Retryability is the meaningful part. A denial is latched and never retried; a
 * revoked session is retryable because retrying is a fresh, legitimate request
 * that will ask the user again rather than a loop against a dead endpoint.
 */
function refuse(message: string, retryable: boolean): ComputerBackendError {
  return new ComputerBackendError(message, { retryable });
}

export class PortalSession {
  private readonly connect: () => Promise<PortalBus>;
  private readonly deviceTypes: number;
  private readonly withScreenCast: boolean;
  private readonly withClipboard: boolean;
  private readonly remoteDesktopVersion: number;
  private readonly desktop: string;
  private readonly restoreTokens: PortalRestoreTokenStore;
  private readonly restoreKey: string;
  private readonly onConsentChanged:
    | ((state: PortalSessionConsent, reason?: string) => void)
    | undefined;
  private readonly startTimeoutMs: number | undefined;

  private bus: PortalBus | undefined;
  private opening: Promise<PortalSessionState> | undefined;
  private state: PortalSessionState | undefined;
  private consent: PortalSessionConsent = "not-requested";
  private deniedReason: string | undefined;
  /** A grant that existed and was taken away, which is not the same as no grant. */
  private revoked = false;
  private revokedReason: string | undefined;
  private disposed = false;
  private readonly subscriptions: (() => void)[] = [];
  private readonly closeListeners = new Set<(reason: string) => void>();
  private readonly selectionTransferListeners = new Set<
    (mimeType: string, serial: number) => void
  >();
  private ownedMimeTypes: readonly string[] = [];

  constructor(options: PortalSessionOptions = {}) {
    this.connect = options.connect ?? (() => connectSessionPortalBus());
    const requested =
      options.deviceTypes ?? REMOTE_DESKTOP_DEVICE_KEYBOARD | REMOTE_DESKTOP_DEVICE_POINTER;
    // Asking for a device the portal does not have produces a grant that is
    // narrower than the dialog implied, so the request is narrowed first and the
    // gap is reported by whoever needed the missing device.
    this.deviceTypes =
      options.availableDeviceTypes === undefined
        ? requested
        : requested & options.availableDeviceTypes;
    this.withScreenCast = options.withScreenCast ?? true;
    this.remoteDesktopVersion = options.remoteDesktopVersion ?? 1;
    this.withClipboard =
      (options.withClipboard ?? true) &&
      this.remoteDesktopVersion >= PORTAL_CLIPBOARD_MINIMUM_REMOTE_DESKTOP_VERSION;
    this.desktop = options.desktop ?? "gnome";
    this.restoreTokens = options.restoreTokens ?? inMemoryRestoreTokenStore();
    this.restoreKey = portalRestoreKey({
      desktop: this.desktop,
      deviceTypes: this.deviceTypes,
      withScreenCast: this.withScreenCast,
    });
    this.onConsentChanged = options.onConsentChanged;
    this.startTimeoutMs = options.startTimeoutMs;
  }

  consentState(): { readonly state: PortalSessionConsent; readonly reason?: string } {
    return this.deniedReason === undefined
      ? { state: this.consent }
      : { state: this.consent, reason: this.deniedReason };
  }

  /** True once `Start` has been answered with a grant that is still alive. */
  isOpen(): boolean {
    return this.state !== undefined;
  }

  /** Fires when the desktop ends the session behind our back. */
  onClosed(listener: (reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /**
   * The grant, opening it if this is the first thing to need it.
   *
   * Concurrent callers share one attempt. Two actions arriving together must
   * not produce two sessions and two dialogs, and the natural shape of a
   * backend — a click that needs input while a screenshot needs capture — makes
   * that the common case rather than the rare one.
   */
  async ensureOpen(): Promise<PortalSessionState> {
    if (this.disposed) {
      throw refuse("The Synara portal session has been shut down.", false);
    }
    if (this.state) return this.state;
    // A revoked grant refuses exactly once before it will re-open. Re-opening
    // silently would put a consent dialog in the middle of a hotkey and then
    // deliver the rest of the chord to whatever the user clicked; refusing
    // forever would make a screen lock permanently disable the backend. Failing
    // the action that discovered the revocation, and letting the next one ask
    // again, is the only reading that keeps the session death a real kill
    // switch without making it terminal.
    if (this.revoked) {
      this.revoked = false;
      throw refuse(
        this.revokedReason ??
          "The desktop ended Synara's remote-control session, so the action did not happen.",
        true,
      );
    }
    if (this.consent === "denied") {
      throw refuse(
        this.deniedReason ??
          "The desktop's permission dialog was dismissed, so Synara has no remote-control grant. " +
            "Nothing will be asked again until you restart computer control from the panel.",
        false,
      );
    }
    this.opening ??= this.open().finally(() => {
      this.opening = undefined;
    });
    return await this.opening;
  }

  private setConsent(state: PortalSessionConsent, reason?: string): void {
    this.consent = state;
    this.deniedReason = reason;
    this.onConsentChanged?.(state, reason);
  }

  private async open(): Promise<PortalSessionState> {
    const bus = await this.ensureBus();
    const sessionToken = portalHandleToken("synara_session");

    const created = await callPortalRequest(bus, {
      interface: PORTAL_REMOTE_DESKTOP_INTERFACE,
      member: "CreateSession",
      options: { session_handle_token: portalString(sessionToken) },
      timeoutMs: 30_000,
    });
    if (created.code !== PORTAL_RESPONSE_SUCCESS) {
      throw refuse(
        `The desktop portal refused to create a remote-control session (response ${created.code}). ` +
          "This usually means xdg-desktop-portal has no backend for RemoteDesktop on this desktop.",
        true,
      );
    }
    const sessionHandle = variantString(created.results.session_handle);
    if (sessionHandle === undefined) {
      throw refuse(
        "The desktop portal created a remote-control session but did not say where it is, " +
          "so nothing can be done with it. This portal implementation is not usable.",
        false,
      );
    }

    // Subscribed before anything else touches the session: revocation can arrive
    // the instant it exists, and a missed `Closed` leaves this object convinced
    // it still holds a grant it does not have.
    this.subscriptions.push(
      await bus.subscribe(
        { path: sessionHandle, interface: PORTAL_SESSION_INTERFACE, member: "Closed" },
        () => this.handleClosed("The desktop ended the remote-control session."),
      ),
    );

    const restoreToken = await this.restoreTokens.read(this.restoreKey);
    const persistence: PortalOptions = {
      persist_mode: portalUint32(PORTAL_PERSIST_MODE_PERSISTENT),
      ...(restoreToken ? { restore_token: portalString(restoreToken) } : {}),
    };

    const selected = await callPortalRequest(bus, {
      interface: PORTAL_REMOTE_DESKTOP_INTERFACE,
      member: "SelectDevices",
      signature: "o",
      body: [sessionHandle],
      options: { types: portalUint32(this.deviceTypes), ...persistence },
      timeoutMs: 30_000,
    });
    if (selected.code !== PORTAL_RESPONSE_SUCCESS) {
      await this.closeSession(bus, sessionHandle);
      throw refuse(
        `The desktop portal refused the requested input devices (response ${selected.code}).`,
        true,
      );
    }

    if (this.withScreenCast) {
      const sources = await callPortalRequest(bus, {
        interface: PORTAL_SCREENCAST_INTERFACE,
        member: "SelectSources",
        signature: "o",
        body: [sessionHandle],
        options: {
          types: portalUint32(SCREENCAST_SOURCE_MONITOR),
          multiple: portalBoolean(true),
          cursor_mode: portalUint32(SCREENCAST_CURSOR_MODE_METADATA),
          ...persistence,
        },
        timeoutMs: 30_000,
      });
      if (sources.code !== PORTAL_RESPONSE_SUCCESS) {
        await this.closeSession(bus, sessionHandle);
        throw refuse(
          `The desktop portal refused to attach a screen stream to the remote-control session ` +
            `(response ${sources.code}), so the pointer would have no coordinate space to aim at.`,
          true,
        );
      }
    }

    let clipboardRequested = false;
    if (this.withClipboard) {
      // Not a Request: it either takes or it does not, and it must land before
      // `Start`, because the grant `Start` freezes is the one the user was
      // shown. A portal that advertises RemoteDesktop v2 without a Clipboard
      // implementation is a real configuration, and the honest answer is a
      // session with no clipboard rather than one that fails at read time.
      clipboardRequested = await bus
        .call({
          destination: PORTAL_BUS_NAME,
          path: PORTAL_OBJECT_PATH,
          interface: PORTAL_CLIPBOARD_INTERFACE,
          member: "RequestClipboard",
          signature: "oa{sv}",
          body: [sessionHandle, {}],
        })
        .then(
          () => true,
          () => false,
        );
    }

    this.setConsent("awaiting");
    const started = await callPortalRequest(bus, {
      interface: PORTAL_REMOTE_DESKTOP_INTERFACE,
      member: "Start",
      signature: "os",
      // No parent window: the server has no window to be modal to, and passing
      // a fabricated identifier makes some portals refuse outright.
      body: [sessionHandle, ""],
      ...(this.startTimeoutMs === undefined ? {} : { timeoutMs: this.startTimeoutMs }),
    });

    if (started.code !== PORTAL_RESPONSE_SUCCESS) {
      await this.closeSession(bus, sessionHandle);
      // A stale restore token is indistinguishable from a refusal here, so it
      // is dropped either way: keeping one that produced a denial guarantees the
      // same denial next time.
      await this.restoreTokens.clear(this.restoreKey);
      const reason =
        started.code === PORTAL_RESPONSE_CANCELLED
          ? "You dismissed the desktop's screen-sharing dialog, so Synara has no permission to control this desktop. " +
            "Start computer control again from the panel to be asked once more."
          : "The desktop ended the screen-sharing request before it was answered, so Synara has no permission to control this desktop. " +
            "Start computer control again from the panel to be asked once more.";
      this.setConsent("denied", reason);
      throw refuse(reason, false);
    }

    const token = variantString(started.results.restore_token);
    if (token) await this.restoreTokens.write(this.restoreKey, token);

    const state: PortalSessionState = {
      sessionHandle,
      devices: variantNumber(started.results.devices) ?? this.deviceTypes,
      streams: parseStreams(started.results.streams),
      // The portal reports the outcome when it knows it; an older one that does
      // not is taken at its word that the request it accepted took effect.
      clipboardEnabled:
        clipboardRequested && (variantBoolean(started.results.clipboard_enabled) ?? true),
    };
    this.state = state;
    this.setConsent("granted");
    return state;
  }

  private async ensureBus(): Promise<PortalBus> {
    if (this.bus) return this.bus;
    const bus = await this.connect();
    this.bus = bus;
    bus.onDisconnected((reason) => {
      this.handleClosed(`The portal D-Bus connection dropped: ${reason.message}`);
      this.bus = undefined;
    });
    return bus;
  }

  /**
   * The session went away without us asking.
   *
   * Consent goes back to `not-requested` rather than to `denied`: the user
   * locking their screen or clicking Stop in the screen-share indicator is not
   * the same act as refusing the dialog, and latching it would leave the backend
   * permanently dead after a lunch break.
   */
  private handleClosed(reason: string): void {
    if (this.state === undefined && this.consent !== "awaiting") return;
    this.state = undefined;
    this.revoked = true;
    this.revokedReason =
      `${reason} The action did not happen. This is what a screen lock, a logout, or Stop in the ` +
      "screen-sharing indicator looks like; the next action will ask for permission again.";
    this.ownedMimeTypes = [];
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
    if (this.consent !== "denied") this.setConsent("not-requested", reason);
    for (const listener of [...this.closeListeners]) listener(reason);
  }

  private async closeSession(bus: PortalBus, sessionHandle: string): Promise<void> {
    await bus
      .call({
        destination: PORTAL_BUS_NAME,
        path: sessionHandle,
        interface: PORTAL_SESSION_INTERFACE,
        member: "Close",
      })
      .catch(() => {
        // Already gone is the expected case on most of these paths.
      });
  }

  /** Drops the grant and the connection the portal ties it to. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const bus = this.bus;
    const handle = this.state?.sessionHandle;
    this.state = undefined;
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
    this.closeListeners.clear();
    this.selectionTransferListeners.clear();
    if (bus) {
      if (handle) await this.closeSession(bus, handle);
      await bus.close().catch(() => undefined);
    }
    this.bus = undefined;
  }

  // -- Input -------------------------------------------------------------

  /**
   * The union of every granted stream, which is the space window bounds and
   * pointer coordinates are expressed in.
   */
  async workspaceRect(): Promise<ComputerRect> {
    const state = await this.ensureOpen();
    const rects = state.streams
      .map((stream) => stream.rect)
      .filter((rect): rect is ComputerRect => rect !== undefined);
    if (rects.length === 0) {
      throw refuse(
        "The desktop portal granted a screen stream but did not say where on the desktop it is, " +
          "so screen coordinates cannot be worked out. This portal reports no monitor position; " +
          "xdg-desktop-portal 1.16 or newer is needed for absolute pointing.",
        false,
      );
    }
    const left = Math.min(...rects.map((rect) => rect.x));
    const top = Math.min(...rects.map((rect) => rect.y));
    const right = Math.max(...rects.map((rect) => rect.x + rect.width));
    const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  /**
   * Absolute motion, which is the only kind that can implement "click there".
   *
   * The portal takes coordinates relative to a stream, so the desktop point is
   * resolved to the monitor containing it. A point on no monitor is clamped into
   * the nearest one rather than refused: the callers that produce these are the
   * geometry helpers, which already clamp to the workspace, and a refusal one
   * pixel outside a bezel would be worse than a click on the edge.
   */
  async movePointerTo(point: ComputerPoint): Promise<void> {
    const state = await this.ensureOpen();
    const target = resolveStreamPoint(state.streams, point);
    if (!target) {
      throw refuse(
        `No granted screen stream covers ${Math.round(point.x)},${Math.round(point.y)}, ` +
          "so the pointer cannot be moved there. The monitor layout changed after permission was granted; " +
          "restart computer control to pick up the new layout.",
        true,
      );
    }
    await this.notify("NotifyPointerMotionAbsolute", "oa{sv}udd", [
      state.sessionHandle,
      {},
      target.nodeId,
      target.x,
      target.y,
    ]);
  }

  async pointerButton(code: number, pressed: boolean): Promise<void> {
    const state = await this.ensureOpen();
    await this.notify("NotifyPointerButton", "oa{sv}iu", [
      state.sessionHandle,
      {},
      Math.trunc(code),
      pressed ? POINTER_BUTTON_PRESSED : POINTER_BUTTON_RELEASED,
    ]);
  }

  /**
   * Keyboard by evdev keycode rather than by keysym.
   *
   * `NotifyKeyboardKeycode` takes exactly the codes `evdevInput.ts` already
   * produces for KWin and for wlroots' virtual keyboard, so all three desktops
   * share one keymap and one hotkey release order. `NotifyKeyboardKeysym` would
   * have meant a second, differently-shaped table for one desktop.
   */
  async key(code: number, pressed: boolean): Promise<void> {
    const state = await this.ensureOpen();
    await this.notify("NotifyKeyboardKeycode", "oa{sv}iu", [
      state.sessionHandle,
      {},
      Math.trunc(code),
      pressed ? POINTER_BUTTON_PRESSED : POINTER_BUTTON_RELEASED,
    ]);
  }

  /**
   * Discrete steps only, unlike the wlroots provider's paired axis events.
   * There the pair rides one `wl_pointer.frame`; the portal has no frame
   * grouping, so `NotifyPointerAxis` alongside this would arrive as a second,
   * separate scroll and double every wheel step. Discrete is the form every
   * toolkit understands on its own.
   */
  async scroll(deltaX: number, deltaY: number): Promise<void> {
    const state = await this.ensureOpen();
    if (deltaY !== 0) {
      await this.notify("NotifyPointerAxisDiscrete", "oa{sv}ui", [
        state.sessionHandle,
        {},
        POINTER_AXIS_VERTICAL,
        Math.trunc(deltaY),
      ]);
    }
    if (deltaX !== 0) {
      await this.notify("NotifyPointerAxisDiscrete", "oa{sv}ui", [
        state.sessionHandle,
        {},
        POINTER_AXIS_HORIZONTAL,
        Math.trunc(deltaX),
      ]);
    }
  }

  private async notify(member: string, signature: string, body: readonly unknown[]): Promise<void> {
    const bus = this.bus;
    if (!bus || this.state === undefined) {
      throw refuse(
        "The desktop ended Synara's remote-control session, so the input was not delivered. " +
          "This happens when the screen locks or when Stop is pressed in the screen-sharing indicator; " +
          "the next action will ask for permission again.",
        true,
      );
    }
    try {
      await bus.call({
        destination: PORTAL_BUS_NAME,
        path: PORTAL_OBJECT_PATH,
        interface: PORTAL_REMOTE_DESKTOP_INTERFACE,
        member,
        signature,
        body,
      });
    } catch (error) {
      throw refuse(
        `The desktop portal rejected ${member}: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
  }

  // -- Clipboard ---------------------------------------------------------

  /** Whether the granted session actually carries the clipboard interface. */
  async clipboardEnabled(): Promise<boolean> {
    const state = await this.ensureOpen();
    return state.clipboardEnabled;
  }

  /**
   * Claims the selection for the given types. The portal then asks for the
   * bytes, one `SelectionTransfer` per pasting application, for as long as this
   * session owns the clipboard.
   */
  async setSelection(mimeTypes: readonly string[]): Promise<void> {
    const state = await this.ensureOpen();
    const bus = this.requireBus();
    this.ownedMimeTypes = [...mimeTypes];
    await bus.call({
      destination: PORTAL_BUS_NAME,
      path: PORTAL_OBJECT_PATH,
      interface: PORTAL_CLIPBOARD_INTERFACE,
      member: "SetSelection",
      signature: "oa{sv}",
      body: [state.sessionHandle, { mime_types: portalStringArray(mimeTypes) }],
    });
  }

  /** The types this session last claimed, so a transfer can be answered honestly. */
  claimedMimeTypes(): readonly string[] {
    return this.ownedMimeTypes;
  }

  async onSelectionTransfer(
    listener: (mimeType: string, serial: number) => void,
  ): Promise<() => void> {
    const state = await this.ensureOpen();
    const bus = this.requireBus();
    this.selectionTransferListeners.add(listener);
    const unsubscribe = await bus.subscribe(
      {
        path: PORTAL_OBJECT_PATH,
        interface: PORTAL_CLIPBOARD_INTERFACE,
        member: "SelectionTransfer",
      },
      (body) => {
        if (variantString(body[0]) !== state.sessionHandle) return;
        const mimeType = variantString(body[1]);
        const serial = variantNumber(body[2]);
        if (mimeType === undefined || serial === undefined) return;
        for (const target of [...this.selectionTransferListeners]) target(mimeType, serial);
      },
    );
    this.subscriptions.push(unsubscribe);
    return () => {
      this.selectionTransferListeners.delete(listener);
      unsubscribe();
    };
  }

  /** The read end of the current selection, as a file descriptor. */
  async selectionRead(mimeType: string): Promise<number> {
    const state = await this.ensureOpen();
    return await this.callForFd(
      PORTAL_CLIPBOARD_INTERFACE,
      "SelectionRead",
      "os",
      [state.sessionHandle, mimeType],
      `read the clipboard as ${mimeType}`,
    );
  }

  /** The write end for one outstanding transfer request. */
  async selectionWrite(serial: number): Promise<number> {
    const state = await this.ensureOpen();
    return await this.callForFd(
      PORTAL_CLIPBOARD_INTERFACE,
      "SelectionWrite",
      "ou",
      [state.sessionHandle, Math.trunc(serial)],
      "hand the clipboard contents to the application asking for them",
    );
  }

  async selectionWriteDone(serial: number, success: boolean): Promise<void> {
    const state = await this.ensureOpen();
    const bus = this.requireBus();
    await bus.call({
      destination: PORTAL_BUS_NAME,
      path: PORTAL_OBJECT_PATH,
      interface: PORTAL_CLIPBOARD_INTERFACE,
      member: "SelectionWriteDone",
      signature: "oub",
      body: [state.sessionHandle, Math.trunc(serial), success],
    });
  }

  // -- Native seams ------------------------------------------------------

  /**
   * The libei socket for this grant.
   *
   * Nothing in TypeScript can drive it: an EIS connection is a libei protocol
   * on that descriptor, not a pipe of bytes. It exists here because the session
   * is the only thing that can produce it, and the native input provider will
   * need exactly this call when it is built.
   */
  async connectToEIS(): Promise<number> {
    const state = await this.ensureOpen();
    return await this.callForFd(
      PORTAL_REMOTE_DESKTOP_INTERFACE,
      "ConnectToEIS",
      "oa{sv}",
      [state.sessionHandle, {}],
      "open a libei input connection",
    );
  }

  /** The PipeWire remote for the granted streams. Same story as `connectToEIS`. */
  async openPipeWireRemote(): Promise<number> {
    const state = await this.ensureOpen();
    return await this.callForFd(
      PORTAL_SCREENCAST_INTERFACE,
      "OpenPipeWireRemote",
      "oa{sv}",
      [state.sessionHandle, {}],
      "open the PipeWire stream for this screen",
    );
  }

  private async callForFd(
    interfaceName: string,
    member: string,
    signature: string,
    body: readonly unknown[],
    attempted: string,
  ): Promise<number> {
    const bus = this.requireBus();
    const reply = await bus.call({
      destination: PORTAL_BUS_NAME,
      path: PORTAL_OBJECT_PATH,
      interface: interfaceName,
      member,
      signature,
      body,
    });
    const fd = variantNumber(reply[0]);
    if (fd === undefined) {
      throw refuse(
        `The desktop portal answered ${member} without a file descriptor, so Synara cannot ${attempted}. ` +
          "This connection was opened without Unix file-descriptor passing, which the portal requires.",
        false,
      );
    }
    return fd;
  }

  private requireBus(): PortalBus {
    const bus = this.bus;
    if (!bus) {
      throw refuse("The portal D-Bus connection is gone, so the desktop cannot be reached.", true);
    }
    return bus;
  }
}

/**
 * `Start` returns `a(ua{sv})`: a node id and a property bag per stream. Only
 * `position` and `size` matter here, and both are optional in the spec — a
 * stream without them still carries pixels but cannot be aimed at.
 */
export function parseStreams(value: unknown): readonly PortalStream[] {
  const streams = unwrapVariant(value);
  if (!Array.isArray(streams)) return [];
  const parsed: PortalStream[] = [];
  for (const entry of streams) {
    const tuple = unwrapVariant(entry);
    if (!Array.isArray(tuple)) continue;
    const nodeId = variantNumber(tuple[0]);
    if (nodeId === undefined) continue;
    const properties = unwrapVariant(tuple[1]);
    const rect = parseStreamRect(properties);
    parsed.push(rect === undefined ? { nodeId } : { nodeId, rect });
  }
  return parsed;
}

function parseStreamRect(properties: unknown): ComputerRect | undefined {
  if (typeof properties !== "object" || properties === null) return undefined;
  const bag = properties as Record<string, unknown>;
  const position = pairOf(bag.position);
  const size = pairOf(bag.size);
  if (!position || !size) return undefined;
  return { x: position[0], y: position[1], width: size[0], height: size[1] };
}

function pairOf(value: unknown): [number, number] | undefined {
  const unwrapped = unwrapVariant(value);
  if (!Array.isArray(unwrapped) || unwrapped.length < 2) return undefined;
  const first = variantNumber(unwrapped[0]);
  const second = variantNumber(unwrapped[1]);
  return first === undefined || second === undefined ? undefined : [first, second];
}

/**
 * Desktop point to (stream, stream-local point).
 *
 * Preference goes to the stream that actually contains the point; failing that,
 * the nearest one, so a coordinate in the gap between two mismatched monitors
 * still lands somewhere sensible instead of failing an otherwise valid click.
 */
export function resolveStreamPoint(
  streams: readonly PortalStream[],
  point: ComputerPoint,
): { readonly nodeId: number; readonly x: number; readonly y: number } | undefined {
  const placed = streams.filter(
    (stream): stream is PortalStream & { rect: ComputerRect } => stream.rect !== undefined,
  );
  if (placed.length === 0) return undefined;
  const containing = placed.find(
    (stream) =>
      point.x >= stream.rect.x &&
      point.x < stream.rect.x + stream.rect.width &&
      point.y >= stream.rect.y &&
      point.y < stream.rect.y + stream.rect.height,
  );
  const chosen =
    containing ??
    placed.reduce((best, stream) =>
      distanceToRect(stream.rect, point) < distanceToRect(best.rect, point) ? stream : best,
    );
  return {
    nodeId: chosen.nodeId,
    x: clamp(point.x - chosen.rect.x, 0, Math.max(0, chosen.rect.width - 1)),
    y: clamp(point.y - chosen.rect.y, 0, Math.max(0, chosen.rect.height - 1)),
  };
}

function distanceToRect(rect: ComputerRect, point: ComputerPoint): number {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
  return Math.hypot(dx, dy);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
