// FILE: layoutMode.test.ts
// Purpose: Covers layout-mode resolution and the `<html data-layout>` writer.
// Layer: Lib unit tests
// Depends on: layoutMode pure helpers and Vitest assertions.

import { describe, expect, it } from "vitest";

import { applyLayoutModeDataset, resolveLayoutMode } from "./layoutMode";

describe("resolveLayoutMode", () => {
  it("maps the phone-width media query to the phone layout", () => {
    expect(resolveLayoutMode(true)).toBe("phone");
  });

  it("maps everything wider to the desktop layout", () => {
    expect(resolveLayoutMode(false)).toBe("desktop");
  });
});

describe("applyLayoutModeDataset", () => {
  it("writes the layout mode onto the target dataset", () => {
    const target = { dataset: {} as { layout?: string } };

    applyLayoutModeDataset(target, "phone");

    expect(target.dataset.layout).toBe("phone");
  });

  it("overwrites a stale layout mode when the viewport changes", () => {
    const target = { dataset: { layout: "phone" } };

    applyLayoutModeDataset(target, "desktop");

    expect(target.dataset.layout).toBe("desktop");
  });
});
