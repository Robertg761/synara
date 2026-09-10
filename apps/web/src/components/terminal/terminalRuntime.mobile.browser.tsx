import "../../index.css";
import "@xterm/xterm/css/xterm.css";

import { expect, it, vi } from "vitest";

const webglCreated = vi.hoisted(() => vi.fn());
vi.mock("../../env", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../env")>(),
  isMobileShell: true,
}));
vi.mock("../../nativeApi", () => ({ readNativeApi: () => undefined }));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    constructor() { webglCreated(); throw new Error("A native mobile terminal must not load WebGL."); }
  },
}));

import {
  attachRuntimeToContainer,
  createRuntimeEntry,
  disposeRuntimeEntry,
  updateRuntimeViewState,
} from "./terminalRuntime";

it("renders mobile terminal output in the DOM without trying WebGL, including after reattachment", async () => {
  const host = document.createElement("div");
  Object.assign(host.style, { width: "390px", height: "420px", position: "relative" });
  document.body.append(host);
  const entry = createRuntimeEntry({
    runtimeKey: "mobile-renderer-test",
    threadId: "mobile-renderer-test",
    terminalId: "terminal-1",
    terminalLabel: "Terminal",
    cwd: "/tmp",
    callbacks: { onSessionExited: vi.fn(), onTerminalMetadataChange: vi.fn(), onTerminalActivityChange: vi.fn() },
  });
  try {
    attachRuntimeToContainer(entry, { autoFocus: false, isVisible: true }, host);
    await new Promise<void>((resolve) => entry.terminal.write("ANDROID_TERMINAL_OK\r\n", resolve));
    await vi.waitFor(() => expect(host.querySelector(".xterm-rows")?.textContent).toContain("ANDROID_TERMINAL_OK"));
    expect(webglCreated).not.toHaveBeenCalled();
    expect(entry.webglAddon).toBeNull();
    updateRuntimeViewState(entry, { autoFocus: false, isVisible: false });
    updateRuntimeViewState(entry, { autoFocus: false, isVisible: true });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await vi.waitFor(() => expect(host.querySelector(".xterm-rows")?.textContent).toContain("ANDROID_TERMINAL_OK"));
    expect(webglCreated).not.toHaveBeenCalled();
  } finally {
    disposeRuntimeEntry(entry);
    host.remove();
  }
});
