// Adapts the isolated Android guest browser to the shared panel API.
import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type {
  BrowserCaptureScreenshotResult,
  BrowserControlMethods,
  NativeApi,
  MobileBrowserPlugin,
  ThreadBrowserState,
} from "@synara/contracts";

const plugin = registerPlugin<MobileBrowserPlugin>("SynaraBrowser");

export function createMobileBrowserApi(native: MobileBrowserPlugin = plugin): NativeApi["browser"] {
  // A renderer reload or server switch must not inherit an old guest session.
  const ready = native.execute({ operation: "reset", input: {} }).then(
    () => null,
    () => new Error("The Android browser could not be initialized."),
  );
  const invoke = async <T,>(operation: string, input: object): Promise<T> => {
    const error = await ready;
    if (error) throw error;
    return native.execute({ operation, input }) as Promise<T>;
  };
  const state = (operation: string, input: object) => invoke<ThreadBrowserState>(operation, input);
  const unsupported = async (): Promise<never> => {
    throw new Error("Browser annotations are not available on Android yet.");
  };
  const captureScreenshot: BrowserControlMethods["captureScreenshot"] = async (input) => {
    const result = await invoke<{ name: string; base64: string }>("captureScreenshot", input);
    const binary = atob(result.base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return { name: result.name, mimeType: "image/png", sizeBytes: bytes.length, bytes } satisfies BrowserCaptureScreenshotResult;
  };
  return {
    capabilities: { embeddedPreview: true, captureScreenshot: true, copyScreenshot: false, annotations: false },
    open: (input) => state("open", input),
    close: (input) => state("close", input),
    hide: (input) => invoke<void>("hide", input),
    getState: (input) => state("getState", input),
    setPanelBounds: (input) => invoke<void>("setPanelBounds", { ...input, viewportWidth: window.innerWidth }),
    // Electron's guest adoption is not used by a native Android view.
    attachWebview: (input) => state("getState", input),
    detachWebview: async () => {},
    navigate: (input) => state("navigate", input),
    reload: (input) => state("reload", input),
    goBack: (input) => state("goBack", input),
    goForward: (input) => state("goForward", input),
    newTab: (input) => state("newTab", input),
    closeTab: (input) => state("closeTab", input),
    selectTab: (input) => state("selectTab", input),
    captureScreenshot,
    copyScreenshotToClipboard: async () => { throw new Error("Use Capture screenshot to attach this page on Android."); },
    copyLink: async (input) => {
      const snapshot = await state("getState", input);
      const tab = snapshot.tabs.find((entry) => entry.id === input.tabId);
      if (tab) await navigator.clipboard.writeText(tab.url);
    },
    openDevTools: async () => { throw new Error("Browser developer tools require the desktop app."); },
    annotations: { start: unsupported, cancel: unsupported, syncMarkers: unsupported, onEvent: () => () => {} },
    onCopyLink: () => () => {},
    onState: (listener) => {
      let disposed = false;
      let handle: PluginListenerHandle | undefined;
      void native.addListener("state", (next) => { if (!disposed) listener(next); }).then((next) => {
        if (disposed) void next.remove();
        else handle = next;
      }).catch(() => {
        console.warn("Browser state updates could not be registered.");
      });
      return () => { disposed = true; void handle?.remove(); };
    },
  };
}
