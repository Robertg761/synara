import type {
  ComputerPoint,
  ComputerRect,
  ComputerScreenSize,
  ComputerTarget,
  ComputerUiNode,
} from "@synara/contracts";

export interface ComputerTargetCandidate {
  readonly label: string;
  readonly role: string;
  readonly windowId: string | null;
  readonly onScreen: boolean;
  readonly frame: ComputerRect;
}

export interface ComputerTargetMatch {
  readonly point: ComputerPoint;
  readonly node: ComputerUiNode;
}

export type ComputerTargetErrorCode =
  | "computer_target_invalid"
  | "computer_target_not_found"
  | "computer_target_ambiguous"
  | "computer_target_offscreen"
  /** The named window is covered at the point and the desktop could not raise it. */
  | "computer_target_occluded"
  /** The desktop declined to deliver input to the named window, and sent none. */
  | "computer_target_refused";

export class ComputerTargetError extends Error {
  readonly code: ComputerTargetErrorCode;
  readonly candidates: readonly ComputerTargetCandidate[];
  readonly notFound: boolean;

  constructor(input: {
    readonly code: ComputerTargetErrorCode;
    readonly message: string;
    readonly candidates?: readonly ComputerTargetCandidate[];
    readonly notFound?: boolean;
  }) {
    super(input.message);
    this.name = "ComputerTargetError";
    this.code = input.code;
    this.candidates = input.candidates ?? [];
    this.notFound = input.notFound ?? input.code === "computer_target_not_found";
  }
}

export function resolveComputerPoint(
  target: ComputerTarget,
  screenSize: ComputerScreenSize,
): ComputerPoint {
  const hasX = typeof target.x === "number";
  const hasY = typeof target.y === "number";
  if (hasX !== hasY) {
    throw new ComputerTargetError({
      code: "computer_target_invalid",
      message: "Computer coordinate targets must include both x and y.",
    });
  }
  if (!hasX || !hasY) {
    throw new ComputerTargetError({
      code: "computer_target_invalid",
      message: "Computer actions require x/y coordinates or a labelled target.",
    });
  }
  const point = { x: target.x, y: target.y } as ComputerPoint;
  if (point.x < 0 || point.y < 0 || point.x >= screenSize.width || point.y >= screenSize.height) {
    throw new ComputerTargetError({
      code: "computer_target_offscreen",
      message: `Computer target (${point.x}, ${point.y}) is outside the ${screenSize.width}x${screenSize.height} screen.`,
      candidates: [],
    });
  }
  return point;
}

export function resolveComputerSemanticTarget(
  root: ComputerUiNode,
  target: ComputerTarget,
): ComputerTargetMatch {
  const candidates = flatten(root).filter((node) => matchesWindow(node, target.windowId));
  const matching = candidates.filter((node) => matchesNode(node, target));
  if (matching.length === 0) {
    throw new ComputerTargetError({
      code: "computer_target_not_found",
      message: `No visible computer target matched ${describeTarget(target)}.`,
      candidates: candidateDescriptions(candidates),
      notFound: true,
    });
  }

  const exact = matching.filter((node) => isExactLabel(node, target.label));
  const ranked = exact.length > 0 ? exact : matching;
  if (ranked.length > 1) {
    throw new ComputerTargetError({
      code: "computer_target_ambiguous",
      message: `Computer target ${describeTarget(target)} matched more than one control.`,
      candidates: candidateDescriptions(ranked),
    });
  }

  const node = ranked[0];
  if (!node) {
    throw new ComputerTargetError({
      code: "computer_target_not_found",
      message: `No visible computer target matched ${describeTarget(target)}.`,
      notFound: true,
    });
  }
  if (!node.onScreen) {
    throw new ComputerTargetError({
      code: "computer_target_offscreen",
      message: `Computer target ${describeTarget(target)} is off-screen; refusing to guess a click.`,
      candidates: candidateDescriptions(ranked),
    });
  }
  return { node, point: activationPointForNode(node) };
}

export function activationPointForNode(node: ComputerUiNode): ComputerPoint {
  if (node.activationPoint) return node.activationPoint;
  return {
    x: node.frame.x + node.frame.width / 2,
    y: node.frame.y + node.frame.height / 2,
  };
}

export function candidateDescriptions(
  nodes: readonly ComputerUiNode[],
): readonly ComputerTargetCandidate[] {
  return nodes.slice(0, 16).map((node) => ({
    label: node.label ?? node.description ?? "(unlabelled)",
    role: node.role,
    windowId: node.windowId,
    onScreen: node.onScreen,
    frame: node.frame,
  }));
}

export function computerTargetCandidates(root: ComputerUiNode): readonly ComputerTargetCandidate[] {
  return candidateDescriptions(flatten(root));
}

export function describeTarget(target: ComputerTarget): string {
  const parts = [
    target.label ? `label=${JSON.stringify(target.label)}` : null,
    target.role ? `role=${JSON.stringify(target.role)}` : null,
    target.windowId ? `window=${JSON.stringify(target.windowId)}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(", ") : "the supplied coordinates";
}

function flatten(root: ComputerUiNode): readonly ComputerUiNode[] {
  const nodes: ComputerUiNode[] = [];
  const visit = (node: ComputerUiNode) => {
    nodes.push(node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return nodes;
}

function matchesWindow(node: ComputerUiNode, windowId: string | undefined): boolean {
  return windowId === undefined || node.windowId === windowId;
}

function matchesNode(node: ComputerUiNode, target: ComputerTarget): boolean {
  if (target.role !== undefined && node.role !== target.role) return false;
  if (target.label === undefined) return true;
  const label = node.label ?? node.description ?? "";
  return (
    label === target.label || label.toLocaleLowerCase().includes(target.label.toLocaleLowerCase())
  );
}

function isExactLabel(node: ComputerUiNode, label: string | undefined): boolean {
  if (label === undefined) return false;
  return (node.label ?? node.description ?? "") === label;
}
