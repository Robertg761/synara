import { expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ desktop: false, browser: undefined as { capabilities?: { embeddedPreview: boolean } } | undefined }));
vi.mock("../env", () => ({ get isElectron() { return runtime.desktop; } }));
vi.mock("../nativeApi", () => ({ readNativeApi: () => ({ browser: runtime.browser }) }));
import { hasEmbeddedBrowser } from "./browserCapabilities";

it("uses native preview capability while preserving legacy Electron and ordinary browser behavior", () => {
  runtime.browser = { capabilities: { embeddedPreview: true } };
  expect(hasEmbeddedBrowser()).toBe(true);
  runtime.browser = undefined;
  expect(hasEmbeddedBrowser()).toBe(false);
  runtime.desktop = true;
  expect(hasEmbeddedBrowser()).toBe(true);
  runtime.browser = { capabilities: { embeddedPreview: false } };
  expect(hasEmbeddedBrowser()).toBe(false);
});
