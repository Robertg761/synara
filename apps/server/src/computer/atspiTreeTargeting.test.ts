import { describe, expect, it } from "vitest";

import type { ComputerUiNode } from "@synara/contracts";

import {
  atspiTextWriteAddress,
  decorationOffsetForClientSize,
  fuseAtspiWindowTree,
  fuseAtspiTrees,
} from "./atspiTreeTargeting.ts";
import { resolveComputerSemanticTarget } from "./uiTreeTargeting.ts";

describe("AT-SPI coordinate fusion", () => {
  it("pins the Phase 0 Plasma frame/client offset", () => {
    expect(
      decorationOffsetForClientSize({ width: 648, height: 518 }, { width: 640, height: 480 }),
    ).toEqual({ x: 4, y: 34 });
  });

  it("turns client-relative widget extents into global targeting points", () => {
    const window = {
      id: "phase0-window" as const,
      bounds: { x: 956, y: 1519, width: 648, height: 518 },
    };
    const fused = fuseAtspiWindowTree({
      window,
      tree: {
        windowId: "phase0-window",
        clientSize: { width: 640, height: 480 },
        root: {
          role: "window",
          label: "Phase 0",
          value: null,
          description: null,
          frame: { x: 0, y: 0, width: 640, height: 480 },
          children: [
            {
              role: "button",
              label: "Target",
              value: null,
              description: null,
              frame: { x: 10, y: 20, width: 100, height: 30 },
              activationPoint: { x: 60, y: 35 },
              children: [],
            },
          ],
        },
      },
    });

    expect(fused.children[0]?.frame).toEqual({
      x: 970,
      y: 1573,
      width: 100,
      height: 30,
    });
    expect(fused.children[0]?.activationPoint).toEqual({ x: 1_020, y: 1_588 });
    expect(fused.children[0]?.windowId).toBe("phase0-window");

    const resolved = resolveComputerSemanticTarget(fused, {
      label: "Target",
      role: "button",
      windowId: "phase0-window",
    });
    expect(resolved.point).toEqual({ x: 1_020, y: 1_588 });
  });

  it("carries the helper's child-index path and editable flag onto fused nodes", () => {
    const fused = fuseAtspiWindowTree({
      window: { id: "editor" as const, bounds: { x: 0, y: 0, width: 640, height: 480 } },
      tree: {
        windowId: "editor",
        clientSize: { width: 640, height: 480 },
        root: {
          role: "window",
          label: "Editor",
          value: null,
          description: null,
          frame: { x: 0, y: 0, width: 640, height: 480 },
          path: [],
          editable: false,
          children: [
            {
              role: "entry",
              label: "Name",
              value: "",
              description: null,
              frame: { x: 10, y: 10, width: 200, height: 24 },
              // The real AT-SPI index, which is not the emitted child position.
              path: [3, 1],
              editable: true,
              children: [],
            },
          ],
        },
      },
    });

    expect(fused.nodePath).toEqual([]);
    expect(fused.editable).toBeUndefined();
    expect(atspiTextWriteAddress(fused.children[0]!)).toEqual({
      windowId: "editor",
      path: [3, 1],
    });
  });

  it("refuses a write address for anything it cannot re-resolve", () => {
    const base: ComputerUiNode = {
      role: "entry",
      label: "Name",
      value: null,
      description: null,
      frame: { x: 0, y: 0, width: 10, height: 10 },
      activationPoint: null,
      onScreen: true,
      windowId: "editor",
      nodePath: [0],
      editable: true,
      children: [],
    };

    expect(atspiTextWriteAddress(base)).toEqual({ windowId: "editor", path: [0] });
    expect(atspiTextWriteAddress({ ...base, editable: false })).toBeUndefined();
    expect(atspiTextWriteAddress({ ...base, editable: undefined })).toBeUndefined();
    expect(atspiTextWriteAddress({ ...base, nodePath: undefined })).toBeUndefined();
    expect(atspiTextWriteAddress({ ...base, windowId: null })).toBeUndefined();
    expect(atspiTextWriteAddress({ ...base, nodePath: [0, -1] })).toBeUndefined();
    expect(atspiTextWriteAddress({ ...base, nodePath: [1.5] })).toBeUndefined();
  });

  it("drops minimized windows from the fused desktop tree", () => {
    const root = fuseAtspiTrees({
      windows: [
        {
          id: "hidden",
          title: "Hidden",
          bounds: { x: 0, y: 0, width: 100, height: 100 },
          focused: false,
          minimized: true,
          visible: true,
        },
      ],
      trees: [
        {
          windowId: "hidden",
          clientSize: { width: 100, height: 100 },
          root: {
            role: "window",
            label: "Hidden",
            value: null,
            description: null,
            frame: { x: 0, y: 0, width: 100, height: 100 },
            children: [],
          },
        },
      ],
      screenSize: { width: 1_920, height: 1_080 },
    });
    expect(root.children).toHaveLength(0);
  });
});
