import { describe, expect, it } from "vitest";

import {
  diffRouteSearchEquals,
  parseDiffRouteSearch,
  stripDiffSearchParams,
} from "./diffRouteSearch";

describe("diffRouteSearchEquals", () => {
  it("detects phone pane changes", () => {
    expect(diffRouteSearchEquals({}, { pane: "pane-1" })).toBe(false);
    expect(diffRouteSearchEquals({ pane: "pane-1" }, { pane: "pane-2" })).toBe(false);
    expect(diffRouteSearchEquals({ pane: "pane-1" }, { pane: "pane-1" })).toBe(true);
  });

  it("detects editor route and selected file changes", () => {
    expect(diffRouteSearchEquals({}, { view: "editor" })).toBe(false);
    expect(
      diffRouteSearchEquals(
        { view: "editor", editorFilePath: "src/first.ts" },
        { view: "editor", editorFilePath: "src/second.ts" },
      ),
    ).toBe(false);
    expect(
      diffRouteSearchEquals(
        { view: "editor", editorFilePath: "src/first.ts" },
        { view: "editor", editorFilePath: "src/first.ts" },
      ),
    ).toBe(true);
  });
});

describe("parseDiffRouteSearch", () => {
  it("parses valid diff search values", () => {
    const parsed = parseDiffRouteSearch({
      panel: "diff",
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({
      panel: "diff",
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });
  });

  it("treats numeric and boolean diff toggles as open", () => {
    expect(
      parseDiffRouteSearch({
        diff: 1,
        diffTurnId: "turn-1",
      }),
    ).toEqual({
      panel: "diff",
      diff: "1",
      diffTurnId: "turn-1",
    });

    expect(
      parseDiffRouteSearch({
        diff: true,
        diffTurnId: "turn-1",
      }),
    ).toEqual({
      panel: "diff",
      diff: "1",
      diffTurnId: "turn-1",
    });
  });

  it("drops turn and file values when diff is closed", () => {
    const parsed = parseDiffRouteSearch({
      diff: "0",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({});
  });

  it("preserves file value for repo diff selections without a turn", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({
      panel: "diff",
      diff: "1",
      diffFilePath: "src/app.ts",
    });
  });

  it("normalizes whitespace-only values", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffTurnId: "  ",
      diffFilePath: "  ",
    });

    expect(parsed).toEqual({
      panel: "diff",
      diff: "1",
    });
  });

  it("preserves browser panel mode without diff state", () => {
    const parsed = parseDiffRouteSearch({
      panel: "browser",
      diffTurnId: "turn-1",
    });

    expect(parsed).toEqual({
      panel: "browser",
    });
  });

  it("preserves split route state while normalizing unrelated values", () => {
    const parsed = parseDiffRouteSearch({
      panel: "browser",
      diffTurnId: "turn-1",
      splitViewId: " split-1 ",
    });

    expect(parsed).toEqual({
      panel: "browser",
      splitViewId: "split-1",
    });
  });

  it("round-trips the phone pane id alongside other route state", () => {
    expect(parseDiffRouteSearch({ pane: "pane-1" })).toEqual({ pane: "pane-1" });
    expect(parseDiffRouteSearch({ pane: " pane-1 ", splitViewId: "split-1" })).toEqual({
      pane: "pane-1",
      splitViewId: "split-1",
    });
  });

  it("drops unusable pane values", () => {
    expect(parseDiffRouteSearch({ pane: "   " })).toEqual({});
    expect(parseDiffRouteSearch({ pane: "" })).toEqual({});
    expect(parseDiffRouteSearch({ pane: 7 })).toEqual({});
    expect(parseDiffRouteSearch({ pane: true })).toEqual({});
    expect(parseDiffRouteSearch({ pane: null })).toEqual({});
    expect(parseDiffRouteSearch({ pane: ["pane-1"] })).toEqual({});
  });

  it("drops the pane id in the editor view, which has no dock", () => {
    expect(parseDiffRouteSearch({ view: "editor", pane: "pane-1" })).toEqual({ view: "editor" });
  });
});

describe("stripDiffSearchParams", () => {
  it("drops the phone pane id with the other panel params", () => {
    expect(
      stripDiffSearchParams({
        splitViewId: "split-1",
        panel: "diff",
        diff: "1",
        diffTurnId: "turn-1",
        diffFilePath: "src/app.ts",
        pane: "pane-1",
      }),
    ).toEqual({ splitViewId: "split-1" });
  });

  it("leaves unrelated search state untouched when no pane is present", () => {
    expect(stripDiffSearchParams({ view: "editor", editorFilePath: "src/app.ts" })).toEqual({
      view: "editor",
      editorFilePath: "src/app.ts",
    });
  });
});
