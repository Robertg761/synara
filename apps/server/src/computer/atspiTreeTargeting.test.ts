import { describe, expect, it } from "vitest";

import {
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
