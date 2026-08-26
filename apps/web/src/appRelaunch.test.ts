// FILE: appRelaunch.test.ts
// Purpose: Verifies that relaunching the app actually fetches a new document under both history
//          modes — the whole point is that nothing built against the previous server survives.
// Layer: Web app routing tests
// Depends on: mocked ./appHistoryMode

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let historyMode: "hash" | "path" = "hash";
vi.mock("./appHistoryMode", () => ({
  get appHistoryMode() {
    return historyMode;
  },
  appRouteDocumentHref: (path: string) => (historyMode === "hash" ? `#${path}` : path),
}));

const replace = vi.fn();
const reload = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("window", { location: { replace, reload } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("relaunchAppAtRoot", () => {
  it("rewrites the fragment and then reloads under hash history", async () => {
    historyMode = "hash";
    const { relaunchAppAtRoot } = await import("./appRelaunch");

    relaunchAppAtRoot();

    // A fragment assignment alone never fetches a document, so the reload is what makes this a
    // relaunch rather than a route change.
    expect(replace).toHaveBeenCalledWith("#/");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(replace.mock.invocationCallOrder[0]).toBeLessThan(
      reload.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("does not stack a reload on the document navigation under path history", async () => {
    historyMode = "path";
    const { relaunchAppAtRoot } = await import("./appRelaunch");

    relaunchAppAtRoot();

    expect(replace).toHaveBeenCalledWith("/");
    expect(reload).not.toHaveBeenCalled();
  });
});
