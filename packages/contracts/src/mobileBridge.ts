// FILE: mobileBridge.ts
// Purpose: Typed contract for the `SynaraShell` Capacitor plugin the mobile shell injects into
// its WebView. This is the whole native surface the web app is allowed to depend on; the web
// side adapts the injected global to this interface in exactly one file (apps/web/src/shellBridge.ts).
// Layer: Shared contracts (types only — no runtime logic)
// Depends on: nothing (mirrors the DesktopBridge interface style in ./ipc)

/** The single paired server the phone remembers. One server per install for now. */
export interface MobileShellSession {
  /** Absolute http(s) URL of the paired Synara server, e.g. `https://box.tail1234.ts.net`. */
  readonly serverUrl: string;
  /** Owner bearer session token minted by that server during pairing. */
  readonly sessionToken: string;
}

/**
 * Secure (Keychain / EncryptedSharedPreferences) storage for the paired session.
 * `get` resolves null when the device has never paired or the session was cleared.
 */
export interface MobileShellSessionStore {
  get: () => Promise<MobileShellSession | null>;
  set: (session: MobileShellSession) => Promise<void>;
  clear: () => Promise<void>;
}

/** Handle returned by `addListener`, matching the Capacitor plugin listener convention. */
export interface MobileShellListenerHandle {
  remove: () => Promise<void>;
}

/**
 * Emitted when the user acts on a notification (or any other native entry point) that targets a
 * thread while the WebView is already alive. `threadId` is untrusted native input: it is a raw
 * string, not a branded ThreadId, and callers must validate it before use.
 */
export interface MobileShellThreadOpenRequestedEvent {
  readonly threadId: string;
}

export interface MobileShellEventMap {
  readonly threadOpenRequested: MobileShellThreadOpenRequestedEvent;
}

export type MobileShellEventName = keyof MobileShellEventMap;

export interface MobileBridge {
  readonly session: MobileShellSessionStore;
  /**
   * Thread id stashed by a notification tap that happened before the WebView was ready to
   * listen, if any. Consuming clears it natively, so a second call resolves null.
   * Untrusted native input — a raw string, not a branded ThreadId.
   */
  consumePendingThreadOpen: () => Promise<string | null>;
  addListener: <E extends MobileShellEventName>(
    eventName: E,
    listener: (event: MobileShellEventMap[E]) => void,
  ) => Promise<MobileShellListenerHandle>;
}
