import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  COMPUTER_ID_MAX_LENGTH,
  COMPUTER_LABEL_MAX_LENGTH,
  COMPUTER_WINDOW_LIST_MAX_LENGTH,
  ComputerWindow,
} from "@synara/contracts";

import { parseWindows } from "./computerGeometry.ts";

const window = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "window-1",
  title: "Terminal",
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  focused: false,
  minimized: false,
  visible: true,
  ...overrides,
});

/**
 * These are the clamp boundaries between what a compositor-side enumerator can
 * report and what the contract's schemas accept. Before they existed, one
 * application with a paragraph-long window title failed the encode of every
 * state payload and push event for the whole session.
 */
describe("parseWindows clamps to the contract", () => {
  it("passes ordinary windows through untouched", () => {
    const windows = parseWindows([window()], null);
    expect(windows).toHaveLength(1);
    expect(Schema.is(ComputerWindow)(windows[0])).toBe(true);
  });

  it("truncates a title and app name past the label maximum", () => {
    const longText = "x".repeat(COMPUTER_LABEL_MAX_LENGTH + 500);
    const windows = parseWindows([window({ id: "w", title: longText, appId: longText })], null);

    expect(windows[0]?.title.length).toBe(COMPUTER_LABEL_MAX_LENGTH);
    expect(windows[0]?.title.endsWith("…")).toBe(true);
    expect(windows[0]?.appName?.length).toBe(COMPUTER_LABEL_MAX_LENGTH);
    expect(Schema.is(ComputerWindow)(windows[0])).toBe(true);
  });

  it("keeps the truncation cut outside a surrogate pair", () => {
    // A astral character right where the cut would land: cutting between its
    // halves would put a lone surrogate — a symbol never displayed — in the
    // title.
    const text = `${"a".repeat(COMPUTER_LABEL_MAX_LENGTH - 1)}\u{1F984}${"b".repeat(100)}`;
    const windows = parseWindows([window({ id: "w", title: text })], null);

    expect(windows[0]?.title.length).toBeLessThanOrEqual(COMPUTER_LABEL_MAX_LENGTH);
    expect(() => decodeURIComponent(windows[0]!.title)).not.toThrow();
    expect(windows[0]?.title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("caps the reported window list at the contract ceiling", () => {
    const items = Array.from({ length: COMPUTER_WINDOW_LIST_MAX_LENGTH + 200 }, (_, index) =>
      window({ id: `window-${index}` }),
    );
    const windows = parseWindows(items, null);

    expect(windows).toHaveLength(COMPUTER_WINDOW_LIST_MAX_LENGTH);
  });

  it("caps one window's occluder list and each occluder id", () => {
    const occluders = Array.from(
      { length: COMPUTER_WINDOW_LIST_MAX_LENGTH * 4 },
      (_, index) => `occluder-${index}`,
    );
    const windows = parseWindows(
      [window({ id: "w", occludedBy: occluders }), window({ id: "cover" })],
      null,
    );

    expect(windows[0]?.occludedBy).toHaveLength(COMPUTER_WINDOW_LIST_MAX_LENGTH);
    expect(Schema.is(ComputerWindow)(windows[0])).toBe(true);
  });

  it("clamps an oversized window id instead of dropping or emitting it raw", () => {
    const longId = "w".repeat(COMPUTER_ID_MAX_LENGTH + 100);
    const windows = parseWindows([window({ id: longId })], null);

    expect(windows[0]?.id.length).toBe(COMPUTER_ID_MAX_LENGTH);
    expect(Schema.is(ComputerWindow)(windows[0])).toBe(true);
  });

  it("still matches the focused window when its id needed clamping", () => {
    const longId = "w".repeat(COMPUTER_ID_MAX_LENGTH + 100);
    const windows = parseWindows([window({ id: longId })], longId);

    expect(windows[0]?.focused).toBe(true);
  });
});
