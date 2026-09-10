import type { ThreadBrowserState } from "./ipc";

/** Secure native storage for the server paired with this install. */
export interface MobileShellSession {
  readonly serverUrl: string;
  readonly sessionToken: string;
}

export interface MobileShellSessionStore {
  get: () => Promise<MobileShellSession | null>;
  set: (session: MobileShellSession) => Promise<void>;
  clear: () => Promise<void>;
}

/** Synara-specific device capabilities. Feature state stays in the shared app. */
export interface MobileBridge {
  readonly session: MobileShellSessionStore;
  /** Consume a native entry URL once, including across renderer reloads. */
  consumeLaunchUrl: (expectedUrl?: string) => Promise<string | null>;
}

/** JSON transport for the Android-owned guest WebView. Never installed on guest pages. */
export interface MobileBrowserPlugin {
  execute(input: { operation: string; input: object }): Promise<unknown>;
  addListener(
    event: "state",
    listener: (state: ThreadBrowserState) => void,
  ): Promise<{ remove(): Promise<void> }>;
}
