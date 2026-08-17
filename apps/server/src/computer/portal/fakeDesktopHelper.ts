/**
 * A scriptable stand-in for the native desktop helper.
 *
 * The wlroots providers are thin by design — the compositor work is in C — so
 * what their unit tests need to check is the translation: which method was
 * called with which arguments, and how its answer becomes a `ComputerWindow`, a
 * screenshot region, or a refusal. A fake transport gives all of that with no
 * compositor, which is what keeps the provider suite runnable on a KDE host, in
 * CI, and on a machine with no display at all.
 *
 * The live protocol is exercised separately by the headless-compositor
 * integration lane, which is the only place that can prove the C side.
 */
import { ComputerBackendError } from "../ComputerBackend.ts";
import type {
  DesktopHelperCapture,
  DesktopHelperCaptureRequest,
  DesktopHelperOutputs,
  DesktopHelperTransport,
  DesktopHelperWindow,
} from "./desktopHelperClient.ts";

/** A 1x1 PNG, rewritten to whatever size a capture claims to have produced. */
const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

export function fakePng(width: number, height: number): Uint8Array {
  const bytes = Uint8Array.from(PNG_1X1);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

export interface FakeDesktopHelperOptions {
  readonly globals?: readonly string[];
  readonly outputs?: DesktopHelperOutputs;
  readonly windows?: readonly DesktopHelperWindow[];
  readonly capture?: (request: DesktopHelperCaptureRequest) => DesktopHelperCapture;
  readonly dispose?: () => Promise<void>;
  /** Makes every method reject, for the refusal paths. */
  readonly failWith?: string;
}

export interface FakeDesktopHelper extends DesktopHelperTransport {
  /** Every call in order, as `method arg,arg`, which is what the tests assert on. */
  readonly calls: string[];
  /** Mutable so a test can change the desktop between two `listWindows` calls. */
  windows: readonly DesktopHelperWindow[];
}

const DEFAULT_OUTPUTS: DesktopHelperOutputs = {
  outputs: [{ name: "HEADLESS-1", rect: { x: 0, y: 0, width: 1920, height: 1080 }, scale: 1 }],
  workspace: { x: 0, y: 0, width: 1920, height: 1080 },
};

export function fakeDesktopHelper(options: FakeDesktopHelperOptions = {}): FakeDesktopHelper {
  const calls: string[] = [];
  const record = <T>(entry: string, value: T): Promise<T> => {
    calls.push(entry);
    if (options.failWith !== undefined) {
      return Promise.reject(new ComputerBackendError(options.failWith));
    }
    return Promise.resolve(value);
  };
  return {
    calls,
    windows: options.windows ?? [],
    globals: () => record("globals", options.globals ?? []),
    outputs: () => record("outputs", options.outputs ?? DEFAULT_OUTPUTS),
    pointerMotion: (x, y) => record(`pointerMotion ${x},${y}`, undefined),
    pointerButton: (code, pressed) => record(`pointerButton ${code},${pressed}`, undefined),
    scroll: (deltaX, deltaY) => record(`scroll ${deltaX},${deltaY}`, undefined),
    key: (code, pressed) => record(`key ${code},${pressed}`, undefined),
    releaseAll: () => record("releaseAll", undefined),
    capture(request) {
      const region = request.region;
      return record(
        `capture ${region.x},${region.y},${region.width},${region.height} max=${request.maxDimension}`,
        options.capture?.(request) ?? {
          bytes: fakePng(region.width, region.height),
          region,
        },
      );
    },
    listWindows() {
      return record("listWindows", this.windows);
    },
    activateWindow: (id) => record(`activateWindow ${id}`, undefined),
    closeWindow: (id) => record(`closeWindow ${id}`, undefined),
    dispose: () => {
      calls.push("dispose");
      return options.dispose?.() ?? Promise.resolve();
    },
  };
}
