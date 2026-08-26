/**
 * An in-process xdg-desktop-portal, for tests.
 *
 * The Tier 2 plan called for a real portal on a private `dbus-daemon`. This is
 * a `PortalBus` implementation instead, for the same reason the desktop helper
 * has `fakeDesktopHelper.ts` rather than a test compositor: the always-on unit
 * suite must not depend on a system daemon being installed, and the interesting
 * behaviour — a dialog answered, dismissed, or revoked mid-action; a portal one
 * version too old to have a clipboard — is behaviour of the *protocol*, which
 * lives entirely above the transport. What a private bus would additionally
 * cover is dbus-next's own marshalling, and that is exercised on real hardware
 * by the GNOME live checklist rather than in CI.
 *
 * It speaks the Request/Response convention properly: a portal method returns a
 * Request object path and the answer arrives later as a signal, with
 * `respondBeforeReply` available to reproduce the ordering that breaks a client
 * which subscribes after calling.
 */
import {
  portalRequestPath,
  portalSessionPath,
  type PortalBus,
  type PortalMethodCall,
  type PortalSignalListener,
  type PortalSignalSpec,
  type PortalVariant,
} from "./portalBus.ts";
import {
  PORTAL_RESPONSE_SUCCESS,
  PORTAL_REQUEST_INTERFACE,
  PORTAL_SESSION_INTERFACE,
  variantString,
} from "./portalRequest.ts";
import { PORTAL_CLIPBOARD_INTERFACE } from "./portalSession.ts";
import {
  PORTAL_REMOTE_DESKTOP_INTERFACE,
  PORTAL_SCREENCAST_INTERFACE,
  REMOTE_DESKTOP_DEVICE_KEYBOARD,
  REMOTE_DESKTOP_DEVICE_POINTER,
} from "./probe.ts";

export interface FakePortalStream {
  readonly nodeId: number;
  /** Omitted to reproduce a portal that reports no monitor position. */
  readonly rect?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export interface FakePortalOptions {
  readonly remoteDesktopVersion?: number;
  /** Undefined reproduces a portal with no ScreenCast interface at all. */
  readonly screenCastVersion?: number;
  readonly availableDeviceTypes?: number;
  /**
   * What the user does at the consent dialog, per `Start`. A function is called
   * once per attempt, so a test can deny and then grant.
   */
  readonly startResponse?: number | (() => number);
  readonly streams?: readonly FakePortalStream[];
  readonly restoreToken?: string;
  /** Whether `org.freedesktop.portal.Clipboard` exists at all. */
  readonly clipboardSupported?: boolean;
  /** Emits `Response` before the method reply, which is legal and load-bearing. */
  readonly respondBeforeReply?: boolean;
  /**
   * Members whose Request is created and never answered — a dialog left open on
   * someone's screen, which is the ordinary way `Start` fails to finish.
   */
  readonly stall?: readonly string[];
  /**
   * Members that answer with a Request path other than the one `handle_token`
   * asked for, reproducing a portal that ignores the token.
   */
  readonly misdirect?: readonly string[];
}

interface FakeRequest {
  readonly path: string;
  /** Held rather than answered, for the calls a test wants to leave hanging. */
  respond(code: number, results: Record<string, PortalVariant>): void;
}

const DEFAULT_STREAMS: readonly FakePortalStream[] = [
  { nodeId: 42, rect: { x: 0, y: 0, width: 1920, height: 1080 } },
];

export class FakePortalService implements PortalBus {
  readonly uniqueName = ":1.77";
  /** Every method that reached the portal, as `Interface.Member`. */
  readonly calls: string[] = [];
  /** Input events only, so a test can assert what actually went to the seat. */
  readonly notifications: { readonly member: string; readonly body: readonly unknown[] }[] = [];
  /** The options dictionary each method was called with, keyed by member. */
  readonly optionsByMember = new Map<string, Record<string, unknown>>();

  private readonly options: FakePortalOptions;
  private readonly listeners = new Map<string, Set<PortalSignalListener>>();
  private readonly disconnectListeners = new Set<(reason: Error) => void>();
  private readonly pending = new Map<string, FakeRequest>();
  private sessionHandle: string | undefined;
  private startAttempts = 0;
  private nextFd = 900;
  private closed = false;
  /** Set once `Start` succeeds; cleared by revocation, like the real thing. */
  private granted = false;
  /** The bytes a `SelectionRead` will produce, as a fake descriptor payload. */
  clipboardText = "";
  readonly writtenFds = new Map<number, string>();

  constructor(options: FakePortalOptions = {}) {
    this.options = options;
  }

  /** The session handle the portal handed out, once one exists. */
  currentSessionHandle(): string | undefined {
    return this.sessionHandle;
  }

  /** The user pressed Stop, or the screen locked. */
  revokeSession(): void {
    const handle = this.sessionHandle;
    if (handle === undefined) return;
    this.granted = false;
    this.emit({ path: handle, interface: PORTAL_SESSION_INTERFACE, member: "Closed" }, [
      handle,
      {},
    ]);
  }

  /** An application asked to paste what this session claims to own. */
  requestSelectionTransfer(mimeType: string, serial: number): void {
    const handle = this.sessionHandle;
    if (handle === undefined) return;
    this.emit(
      {
        path: "/org/freedesktop/portal/desktop",
        interface: PORTAL_CLIPBOARD_INTERFACE,
        member: "SelectionTransfer",
      },
      [
        { signature: "o", value: handle },
        { signature: "s", value: mimeType },
        { signature: "u", value: serial },
      ],
    );
  }

  dropConnection(reason = "the fake portal connection was dropped"): void {
    const error = new Error(reason);
    for (const listener of [...this.disconnectListeners]) listener(error);
  }

  async call(call: PortalMethodCall): Promise<readonly unknown[]> {
    if (this.closed) throw new Error("the fake portal connection is closed");
    const member = `${call.interface}.${call.member}`;
    this.calls.push(member);
    const body = call.body ?? [];
    const options = lastOptions(body);
    if (options) this.optionsByMember.set(call.member, options);

    switch (member) {
      case "org.freedesktop.DBus.Properties.Get":
        return [{ signature: "u", value: this.propertyValue(String(body[0]), String(body[1])) }];

      case `${PORTAL_REMOTE_DESKTOP_INTERFACE}.CreateSession`: {
        const handle = portalSessionPath(
          this.uniqueName,
          variantString(options?.session_handle_token) ?? "session",
        );
        this.sessionHandle = handle;
        return this.request(call.member, options, PORTAL_RESPONSE_SUCCESS, {
          session_handle: { signature: "s", value: handle },
        });
      }

      case `${PORTAL_REMOTE_DESKTOP_INTERFACE}.SelectDevices`:
        return this.request(call.member, options, PORTAL_RESPONSE_SUCCESS, {});

      case `${PORTAL_SCREENCAST_INTERFACE}.SelectSources`:
        if (this.options.screenCastVersion === undefined) {
          throw new Error("org.freedesktop.DBus.Error.UnknownMethod: no ScreenCast interface");
        }
        return this.request(call.member, options, PORTAL_RESPONSE_SUCCESS, {});

      case `${PORTAL_REMOTE_DESKTOP_INTERFACE}.Start`: {
        const code = this.nextStartResponse();
        if (code !== PORTAL_RESPONSE_SUCCESS) return this.request(call.member, options, code, {});
        this.granted = true;
        return this.request(call.member, options, PORTAL_RESPONSE_SUCCESS, {
          devices: {
            signature: "u",
            value:
              this.options.availableDeviceTypes ??
              REMOTE_DESKTOP_DEVICE_KEYBOARD | REMOTE_DESKTOP_DEVICE_POINTER,
          },
          streams: {
            signature: "a(ua{sv})",
            value: encodeStreams(this.options.streams ?? DEFAULT_STREAMS),
          },
          ...(this.options.restoreToken
            ? { restore_token: { signature: "s", value: this.options.restoreToken } }
            : {}),
        });
      }

      case `${PORTAL_REMOTE_DESKTOP_INTERFACE}.NotifyPointerMotionAbsolute`:
      case `${PORTAL_REMOTE_DESKTOP_INTERFACE}.NotifyPointerButton`:
      case `${PORTAL_REMOTE_DESKTOP_INTERFACE}.NotifyKeyboardKeycode`:
      case `${PORTAL_REMOTE_DESKTOP_INTERFACE}.NotifyPointerAxisDiscrete`:
        this.requireGrant(call.member);
        this.notifications.push({ member: call.member, body });
        return [];

      case `${PORTAL_CLIPBOARD_INTERFACE}.RequestClipboard`:
        this.requireClipboard();
        return [];

      case `${PORTAL_CLIPBOARD_INTERFACE}.SetSelection`:
        this.requireClipboard();
        return [];

      case `${PORTAL_CLIPBOARD_INTERFACE}.SelectionRead`: {
        this.requireClipboard();
        const mimeType = String(body[1]);
        if (!mimeType.startsWith("text/plain")) {
          throw new Error(`org.freedesktop.portal.Error.Failed: no ${mimeType} on the clipboard`);
        }
        const fd = this.nextFd++;
        this.writtenFds.set(fd, this.clipboardText);
        return [{ signature: "h", value: fd }];
      }

      case `${PORTAL_CLIPBOARD_INTERFACE}.SelectionWrite`: {
        this.requireClipboard();
        const fd = this.nextFd++;
        this.writtenFds.set(fd, "");
        return [{ signature: "h", value: fd }];
      }

      case `${PORTAL_CLIPBOARD_INTERFACE}.SelectionWriteDone`:
        return [];

      case `${PORTAL_SCREENCAST_INTERFACE}.OpenPipeWireRemote`:
      case `${PORTAL_REMOTE_DESKTOP_INTERFACE}.ConnectToEIS`:
        this.requireGrant(call.member);
        return [{ signature: "h", value: this.nextFd++ }];

      case `${PORTAL_SESSION_INTERFACE}.Close`:
        this.granted = false;
        this.sessionHandle = undefined;
        return [];

      case `${PORTAL_REQUEST_INTERFACE}.Close`:
        this.pending.delete(call.path);
        return [];

      default:
        throw new Error(`org.freedesktop.DBus.Error.UnknownMethod: ${member}`);
    }
  }

  subscribe(spec: PortalSignalSpec, listener: PortalSignalListener): Promise<() => void> {
    const key = signalKey(spec);
    const set = this.listeners.get(key) ?? new Set<PortalSignalListener>();
    set.add(listener);
    this.listeners.set(key, set);
    return Promise.resolve(() => set.delete(listener));
  }

  onDisconnected(listener: (reason: Error) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  close(): Promise<void> {
    this.closed = true;
    this.granted = false;
    this.listeners.clear();
    return Promise.resolve();
  }

  /** Answers a request the test asked to be left hanging. */
  answerPending(code: number, results: Record<string, PortalVariant> = {}): boolean {
    const next = [...this.pending.values()][0];
    if (!next) return false;
    this.pending.delete(next.path);
    next.respond(code, results);
    return true;
  }

  private request(
    member: string,
    options: Record<string, unknown> | undefined,
    code: number,
    results: Record<string, PortalVariant>,
  ): readonly unknown[] {
    const token = variantString(options?.handle_token) ?? "request";
    const path = portalRequestPath(this.uniqueName, token);
    const respond = (responseCode: number, responseResults: Record<string, PortalVariant>) => {
      this.emit({ path, interface: PORTAL_REQUEST_INTERFACE, member: "Response" }, [
        responseCode,
        responseResults,
      ]);
    };
    if (this.options.misdirect?.includes(member)) {
      return [portalRequestPath(this.uniqueName, "a_token_nobody_asked_for")];
    }
    if (this.options.stall?.includes(member)) {
      this.pending.set(path, { path, respond });
      return [path];
    }
    if (this.options.respondBeforeReply) {
      respond(code, results);
    } else {
      // The real portal answers on its own schedule; a microtask reproduces the
      // ordinary case where the reply lands first.
      queueMicrotask(() => {
        if (this.closed) return;
        respond(code, results);
      });
    }
    return [path];
  }

  private nextStartResponse(): number {
    this.startAttempts += 1;
    const configured = this.options.startResponse;
    if (typeof configured === "function") return configured();
    return configured ?? PORTAL_RESPONSE_SUCCESS;
  }

  /** How many times the consent dialog was raised, which a latch test asserts on. */
  startCount(): number {
    return this.startAttempts;
  }

  private requireGrant(member: string): void {
    if (this.granted) return;
    throw new Error(
      `org.freedesktop.portal.Error.Failed: ${member} on a session that is not running`,
    );
  }

  private requireClipboard(): void {
    if (this.options.clipboardSupported === false) {
      throw new Error("org.freedesktop.DBus.Error.UnknownMethod: no Clipboard interface");
    }
  }

  private propertyValue(interfaceName: string, property: string): number {
    if (interfaceName === PORTAL_REMOTE_DESKTOP_INTERFACE) {
      return property === "version"
        ? (this.options.remoteDesktopVersion ?? 2)
        : (this.options.availableDeviceTypes ??
            REMOTE_DESKTOP_DEVICE_KEYBOARD | REMOTE_DESKTOP_DEVICE_POINTER);
    }
    return this.options.screenCastVersion ?? 5;
  }

  private emit(spec: PortalSignalSpec, body: readonly unknown[]): void {
    const listeners = this.listeners.get(signalKey(spec));
    if (!listeners) return;
    for (const listener of [...listeners]) listener(body);
  }
}

function signalKey(spec: PortalSignalSpec): string {
  return `${spec.path} ${spec.interface} ${spec.member}`;
}

function lastOptions(body: readonly unknown[]): Record<string, unknown> | undefined {
  const last = body[body.length - 1];
  if (typeof last !== "object" || last === null || Array.isArray(last)) return undefined;
  return last as Record<string, unknown>;
}

function encodeStreams(streams: readonly FakePortalStream[]): unknown[] {
  return streams.map((stream) => [
    stream.nodeId,
    stream.rect === undefined
      ? {}
      : {
          position: { signature: "(ii)", value: [stream.rect.x, stream.rect.y] },
          size: { signature: "(ii)", value: [stream.rect.width, stream.rect.height] },
        },
  ]);
}
