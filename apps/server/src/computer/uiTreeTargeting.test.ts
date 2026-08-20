import { describe, expect, it } from "vitest";

import type { ComputerUiNode, ComputerWindowId } from "@synara/contracts";

import {
  ComputerTargetError,
  activationPointForNode,
  computerTargetCandidates,
  resolveComputerPoint,
  resolveComputerSemanticTarget,
} from "./uiTreeTargeting.ts";

const windowId = (value: string): ComputerWindowId => value as ComputerWindowId;

function node(partial: Partial<ComputerUiNode> & { readonly role: string }): ComputerUiNode {
  return {
    role: partial.role,
    label: partial.label ?? null,
    value: partial.value ?? null,
    description: partial.description ?? null,
    frame: partial.frame ?? { x: 0, y: 0, width: 1_920, height: 1_080 },
    activationPoint: partial.activationPoint ?? null,
    onScreen: partial.onScreen ?? true,
    windowId: partial.windowId ?? null,
    children: partial.children ?? [],
  };
}

const DESKTOP = node({
  role: "desktop",
  description: "AT-SPI desktop",
  children: [
    node({
      role: "push button",
      label: "Save",
      windowId: windowId("editor"),
      frame: { x: 100, y: 200, width: 80, height: 30 },
      activationPoint: { x: 140, y: 215 },
    }),
    node({
      role: "push button",
      label: "Save As",
      windowId: windowId("editor"),
      frame: { x: 200, y: 200, width: 80, height: 30 },
    }),
    node({
      role: "menu item",
      label: "Save",
      windowId: windowId("browser"),
      frame: { x: 900, y: 200, width: 80, height: 30 },
    }),
  ],
});

function thrown(run: () => unknown): ComputerTargetError {
  try {
    run();
  } catch (cause) {
    return cause as ComputerTargetError;
  }
  throw new Error("expected a ComputerTargetError");
}

describe("resolving a coordinate target", () => {
  const screen = { width: 1_920, height: 1_080, scale: 1 };

  it("takes a point that is on the screen", () => {
    expect(resolveComputerPoint({ x: 10, y: 20 }, screen)).toEqual({ x: 10, y: 20 });
  });

  it("refuses half a coordinate and a coordinate past the edge", () => {
    const half = thrown(() => resolveComputerPoint({ x: 10 }, screen));
    expect(half.code).toBe("computer_target_invalid");
    const past = thrown(() => resolveComputerPoint({ x: 1_920, y: 10 }, screen));
    expect(past.code).toBe("computer_target_offscreen");
  });
});

describe("resolving a labelled desktop target", () => {
  it("returns the control's own activation point when it has one", () => {
    const match = resolveComputerSemanticTarget(DESKTOP, { label: "Save", role: "push button" });
    expect(match.point).toEqual({ x: 140, y: 215 });
    expect(match.node.windowId).toBe("editor");
  });

  it("falls back to the frame centre for a control with no activation point", () => {
    const plain = node({ role: "x", frame: { x: 10, y: 20, width: 100, height: 40 } });
    expect(activationPointForNode(plain)).toEqual({ x: 60, y: 40 });
  });

  it("prefers an exact label over a longer one that contains it", () => {
    const target = { label: "Save", windowId: windowId("editor") };
    expect(resolveComputerSemanticTarget(DESKTOP, target).node.frame.x).toBe(100);
  });

  it("scopes matching to the named window", () => {
    const target = { label: "Save", windowId: windowId("browser") };
    expect(resolveComputerSemanticTarget(DESKTOP, target).node.role).toBe("menu item");
  });

  it("falls back to substring when no label matches exactly", () => {
    expect(resolveComputerSemanticTarget(DESKTOP, { label: "ave As" }).node.label).toBe("Save As");
  });

  it("compares a role verbatim rather than loosely", () => {
    // AT-SPI role names are a fixed vocabulary, so a near miss is a wrong role
    // and not a spelling to be forgiven.
    const error = thrown(() => resolveComputerSemanticTarget(DESKTOP, { role: "Push Button" }));
    expect(error.code).toBe("computer_target_not_found");
  });

  it("matches a label without trimming the query", () => {
    // Nothing trims a label arriving over MCP, and quietly acting on a control
    // the caller did not name is worse than a refusal they can correct.
    const error = thrown(() => resolveComputerSemanticTarget(DESKTOP, { label: " Save " }));
    expect(error.code).toBe("computer_target_not_found");
  });

  it("refuses a label that names a control in two windows", () => {
    const error = thrown(() => resolveComputerSemanticTarget(DESKTOP, { label: "Save" }));
    expect(error.code).toBe("computer_target_ambiguous");
    expect(error.candidates).toHaveLength(2);
  });

  it("trusts the perception source's own on-screen flag", () => {
    const desktop = node({
      role: "desktop",
      children: [
        node({
          role: "push button",
          label: "Hidden",
          onScreen: false,
          // On screen by coordinates; the source knows better, and is believed.
          frame: { x: 10, y: 10, width: 80, height: 30 },
        }),
      ],
    });
    const error = thrown(() => resolveComputerSemanticTarget(desktop, { label: "Hidden" }));
    expect(error.code).toBe("computer_target_offscreen");
    expect(error.candidates).toHaveLength(1);
  });
});

describe("naming the candidates", () => {
  it("puts the candidates in the message, not only in the structured field", () => {
    // Every transport between here and the model — MCP tool errors, WsRpcError —
    // is only guaranteed to carry the message, and a "no such label" with no
    // list of the real ones is a dead end.
    const error = thrown(() => resolveComputerSemanticTarget(DESKTOP, { label: "Print" }));
    expect(error.code).toBe("computer_target_not_found");
    expect(error.candidates.length).toBeGreaterThan(0);
    expect(error.message).toContain("Save As");
    expect(error.message).toContain("push button");
    expect(error.message).toContain('in window "editor"');
  });

  it("leaves a message alone when there are no candidates to name", () => {
    const screen = { width: 100, height: 100 };
    const error = thrown(() => resolveComputerPoint({ x: 5_000, y: 10 }, screen));
    expect(error.message).toBe("Computer target (5000, 10) is outside the 100x100 screen.");
  });

  it("caps a candidate list at sixteen entries", () => {
    const desktop = node({
      role: "desktop",
      children: Array.from({ length: 40 }, (_unused, index) =>
        node({ role: "push button", label: `Button ${index}` }),
      ),
    });
    // The root counts too: the cap is on the flattened list, not on the children.
    expect(computerTargetCandidates(desktop)).toHaveLength(16);
    const error = thrown(() => resolveComputerSemanticTarget(desktop, { label: "Nope" }));
    expect(error.candidates).toHaveLength(16);
  });
});
