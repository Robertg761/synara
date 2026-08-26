import { describe, expect, it } from "vitest";

import {
  NO_PREVIOUS_STORE_PANE,
  resolvePhonePaneSync,
  type PhonePaneSyncInput,
} from "./phonePaneRoute.logic";

/** Defaults describe the first pass of a fresh lifetime with an empty URL and a closed dock. */
function sync(overrides: Partial<PhonePaneSyncInput>) {
  return resolvePhonePaneSync({
    urlPaneId: null,
    urlPaneExists: false,
    storePaneId: null,
    previousStorePaneId: NO_PREVIOUS_STORE_PANE,
    lastShownPaneId: null,
    ...overrides,
  });
}

describe("resolvePhonePaneSync", () => {
  describe("first pass of a lifetime (mount, thread switch, phone layout re-entry)", () => {
    it("adopts a URL pane that still exists", () => {
      expect(sync({ urlPaneId: "pane-1", urlPaneExists: true })).toEqual({
        kind: "adoptUrlPane",
        paneId: "pane-1",
      });
    });

    it("adopts the URL pane even when the store presents a different one", () => {
      expect(sync({ urlPaneId: "pane-1", urlPaneExists: true, storePaneId: "pane-2" })).toEqual({
        kind: "adoptUrlPane",
        paneId: "pane-1",
      });
    });

    it("replaces a param that names no live pane", () => {
      expect(sync({ urlPaneId: "gone", urlPaneExists: false })).toEqual({
        kind: "clearPaneParam",
        reason: "stale",
      });
      expect(sync({ urlPaneId: "gone", urlPaneExists: false, storePaneId: "pane-2" })).toEqual({
        kind: "clearPaneParam",
        reason: "stale",
      });
    });

    it("leaves a persisted open dock completely alone when the URL has no pane", () => {
      // The narrow-a-desktop-window case: dismissing here would destroy a dock the user
      // never asked to close, and widening the window back would not restore it.
      expect(sync({ storePaneId: "pane-1" })).toEqual({ kind: "none" });
    });

    it("does nothing when both sides are empty", () => {
      expect(sync({})).toEqual({ kind: "none" });
    });
  });

  describe("store transitions (the only signal that classifies store-driven intent)", () => {
    it("pushes a history entry when the store opens a pane under an empty URL", () => {
      expect(sync({ previousStorePaneId: null, storePaneId: "pane-1" })).toEqual({
        kind: "pushPaneParam",
        paneId: "pane-1",
      });
    });

    it("pushes the newly selected pane when the store switches under a live param", () => {
      expect(
        sync({
          urlPaneId: "pane-1",
          urlPaneExists: true,
          storePaneId: "pane-2",
          previousStorePaneId: "pane-1",
          lastShownPaneId: "pane-1",
        }),
      ).toEqual({ kind: "pushPaneParam", paneId: "pane-2" });
    });

    it("clears the param when the dock collapses under the pane on screen", () => {
      // Header toggle / programmatic collapse: the pane still exists, but nothing is presented.
      expect(
        sync({
          urlPaneId: "pane-1",
          urlPaneExists: true,
          storePaneId: null,
          previousStorePaneId: "pane-1",
          lastShownPaneId: "pane-1",
        }),
      ).toEqual({ kind: "clearPaneParam", reason: "closed" });
    });

    it("does not push when the store settles back onto the pane the URL already names", () => {
      expect(
        sync({
          urlPaneId: "pane-1",
          urlPaneExists: true,
          storePaneId: "pane-1",
          previousStorePaneId: null,
          lastShownPaneId: "pane-1",
        }),
      ).toEqual({ kind: "none" });
    });

    it("does not push when the store closes down to nothing with an empty URL", () => {
      expect(sync({ previousStorePaneId: "pane-1", storePaneId: null })).toEqual({ kind: "none" });
    });
  });

  describe("pane the URL names disappeared", () => {
    it("reports a close when it is the pane that was on screen", () => {
      expect(
        sync({ urlPaneId: "pane-1", urlPaneExists: false, lastShownPaneId: "pane-1" }),
      ).toEqual({ kind: "clearPaneParam", reason: "closed" });
    });

    it("reports a stale param when the screen was never showing it", () => {
      expect(
        sync({
          urlPaneId: "pane-1",
          urlPaneExists: false,
          lastShownPaneId: "pane-2",
          previousStorePaneId: "pane-2",
          storePaneId: "pane-2",
        }),
      ).toEqual({ kind: "clearPaneParam", reason: "stale" });
    });
  });

  describe("back navigation", () => {
    it("dismisses the dock when the URL drops the pane the screen was showing", () => {
      expect(sync({ storePaneId: "pane-1", lastShownPaneId: "pane-1" })).toEqual({
        kind: "dismissDock",
      });
    });

    it("does not dismiss when nothing was on screen", () => {
      expect(sync({ storePaneId: "pane-1", previousStorePaneId: "pane-1" })).toEqual({
        kind: "none",
      });
    });

    it("does not dismiss when the store already moved to another pane", () => {
      expect(
        sync({
          storePaneId: "pane-2",
          previousStorePaneId: "pane-1",
          lastShownPaneId: "pane-1",
        }),
      ).toEqual({ kind: "pushPaneParam", paneId: "pane-2" });
    });
  });

  describe("sequences", () => {
    it("settles a full open / back / re-open cycle without oscillating", () => {
      // 1. cold state, nothing anywhere.
      expect(sync({})).toEqual({ kind: "none" });
      // 2. the store opens pane-1 -> push.
      expect(sync({ previousStorePaneId: null, storePaneId: "pane-1" })).toEqual({
        kind: "pushPaneParam",
        paneId: "pane-1",
      });
      // 3. the pushed URL lands.
      expect(
        sync({
          urlPaneId: "pane-1",
          urlPaneExists: true,
          storePaneId: "pane-1",
          previousStorePaneId: null,
          lastShownPaneId: null,
        }),
      ).toEqual({ kind: "none" });
      // 4. back drops the param while the store still holds the pane.
      expect(
        sync({
          storePaneId: "pane-1",
          previousStorePaneId: "pane-1",
          lastShownPaneId: "pane-1",
        }),
      ).toEqual({ kind: "dismissDock" });
      // 5. the dock collapsed; nothing is left to reconcile.
      expect(sync({ previousStorePaneId: "pane-1", storePaneId: null })).toEqual({ kind: "none" });
      // 6. re-opening the same pane is a fresh null -> pane-1 transition, so it pushes again.
      expect(sync({ previousStorePaneId: null, storePaneId: "pane-1" })).toEqual({
        kind: "pushPaneParam",
        paneId: "pane-1",
      });
    });

    it("recovers from closing a stacked pane instead of wedging on the entry below", () => {
      // Explorer is on screen and the store opens a file pane on top of it.
      expect(
        sync({
          urlPaneId: "explorer",
          urlPaneExists: true,
          storePaneId: "file",
          previousStorePaneId: "explorer",
          lastShownPaneId: "explorer",
        }),
      ).toEqual({ kind: "pushPaneParam", paneId: "file" });
      // Closing the file pane makes the explorer active again; the param no longer resolves.
      expect(
        sync({
          urlPaneId: "file",
          urlPaneExists: false,
          storePaneId: "explorer",
          previousStorePaneId: "file",
          lastShownPaneId: "file",
        }),
      ).toEqual({ kind: "clearPaneParam", reason: "closed" });
      // Popping lands back on ?pane=explorer, which is just an ordinary consistent pass.
      expect(
        sync({
          urlPaneId: "explorer",
          urlPaneExists: true,
          storePaneId: "explorer",
          previousStorePaneId: "explorer",
          lastShownPaneId: null,
        }),
      ).toEqual({ kind: "none" });
      // ...and opening the next pane still works.
      expect(
        sync({
          urlPaneId: "explorer",
          urlPaneExists: true,
          storePaneId: "file-2",
          previousStorePaneId: "explorer",
          lastShownPaneId: "explorer",
        }),
      ).toEqual({ kind: "pushPaneParam", paneId: "file-2" });
    });

    it("keeps a store switch that raced an in-flight navigation", () => {
      // The push for pane-b lands while the store has already moved to pane-c: the pass that
      // finally runs sees a store transition against the pre-push snapshot and pushes pane-c
      // rather than reverting the store to pane-b.
      expect(
        sync({
          urlPaneId: "pane-b",
          urlPaneExists: true,
          storePaneId: "pane-c",
          previousStorePaneId: null,
          lastShownPaneId: null,
        }),
      ).toEqual({ kind: "pushPaneParam", paneId: "pane-c" });
    });
  });
});
