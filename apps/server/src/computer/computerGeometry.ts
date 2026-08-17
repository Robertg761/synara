/**
 * Desktop geometry and payload parsing shared by every computer backend.
 *
 * None of this is compositor-specific. The workspace rect, the screenshot
 * mapping (`desktop = region.origin + pixel / scale`), the PNG header read, and
 * the window-list shape are the coordinate contract the agent's tool surface is
 * written against, so a second backend has to produce exactly the same numbers
 * or every coordinate the model learned on one desktop is wrong on the other.
 *
 * The payload helpers live here rather than in a module of their own because
 * `parseWindows` is the only reason they exist: window JSON arrives either as a
 * plain string or wrapped in a D-Bus variant, depending on which transport
 * carried it, and the KWin plugin and the planned GNOME Shell extension emit
 * the identical document.
 */
import type {
  ComputerPoint,
  ComputerRect,
  ComputerScreenshot,
  ComputerScreenSize,
  ComputerWindow,
} from "@synara/contracts";

import { ComputerBackendError } from "./ComputerBackend.ts";

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const PNG_IHDR = Uint8Array.of(0x49, 0x48, 0x44, 0x52);
/** Prefix of the message a capture failure carries when no backend names itself. */
const DEFAULT_CAPTURE_SOURCE = "The desktop capture";

// ── Payload decoding ─────────────────────────────────────────────────

/** Unwraps a `dbus-next` variant, however many layers deep it was wrapped. */
export function unwrapDbusValue(value: unknown): unknown {
  if (isDbusVariant(value)) {
    return unwrapDbusValue((value as { readonly value: unknown }).value);
  }
  return value;
}

function isDbusVariant(
  value: unknown,
): value is { readonly signature: string; readonly value: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly signature?: unknown }).signature === "string" &&
    "value" in value
  );
}

/**
 * A JSON document that may still be a string, a variant-wrapped string, or an
 * already-decoded value. Malformed JSON decodes to `null` rather than throwing:
 * every caller degrades to "the display server told us nothing", which is a
 * state they all have to handle anyway.
 */
export function parseJsonPayload(value: unknown): unknown {
  const unwrapped = unwrapDbusValue(value);
  if (typeof unwrapped === "string") {
    try {
      return JSON.parse(unwrapped);
    } catch {
      return null;
    }
  }
  return unwrapped;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asNonNegativeInt(value: unknown): number | undefined {
  const numeric = asFiniteNumber(value);
  return numeric === undefined || numeric < 0 ? undefined : Math.trunc(numeric);
}

export function parseComputerRect(value: unknown): ComputerRect | undefined {
  const record = asRecord(value);
  const x = asFiniteNumber(record.x);
  const y = asFiniteNumber(record.y);
  const width = asFiniteNumber(record.width);
  const height = asFiniteNumber(record.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined)
    return undefined;
  if (width < 0 || height < 0) return undefined;
  return { x, y, width, height };
}

export function parseComputerPoint(value: unknown): ComputerPoint | null {
  const record = asRecord(value);
  const x = asFiniteNumber(record.x);
  const y = asFiniteNumber(record.y);
  return x === undefined || y === undefined ? null : { x, y };
}

/**
 * Occluder ids from a source that reports them. Both the field and its
 * individual entries degrade to absent rather than failing the whole window
 * list, because stacking metadata is an optional hint and an older loaded
 * plugin omits it entirely. An empty list is dropped: "nothing above this
 * window" is what an absent field already means.
 */
function asWindowIds(value: unknown): readonly ComputerWindow["id"][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return ids.length > 0 ? (ids as ComputerWindow["id"][]) : undefined;
}

/**
 * The window list emitted by a compositor-side enumerator: the KWin plugin
 * today, a GNOME Shell extension next, both producing the same document on
 * purpose so this stays one parser.
 *
 * An entry without an id or without a parseable rect is dropped rather than
 * reported bounds-less. `ComputerWindow.bounds` being optional describes a
 * display server that has no geometry to give at all, which is a property of
 * the provider and is declared through `ComputerCapabilities.windowBounds`; a
 * single malformed entry from a source that does report geometry is a bug in
 * that entry, and admitting it would put an unlocatable window in front of a
 * model that has no way to tell the two cases apart.
 */
export function parseWindows(value: unknown, focusedWindowId: string | null): ComputerWindow[] {
  const parsed = parseJsonPayload(value);
  const items = Array.isArray(parsed) ? parsed : [];
  const windows: ComputerWindow[] = [];
  for (const item of items) {
    const record = asRecord(item);
    const id = asString(record.id) ?? asString(record.windowId);
    const bounds = parseComputerRect(record.bounds);
    if (!id || !bounds) continue;
    const title = asString(record.title) ?? "";
    const appName = asString(record.appId) ?? asString(record.resourceClass);
    const pid =
      typeof record.pid === "number" && record.pid > 0 ? Math.trunc(record.pid) : undefined;
    const stackingIndex = asNonNegativeInt(record.stackingIndex);
    const occludedBy = asWindowIds(record.occludedBy);
    windows.push({
      id: id as ComputerWindow["id"],
      title,
      ...(appName ? { appName } : {}),
      ...(pid ? { pid } : {}),
      bounds,
      focused: record.focused === true || id === focusedWindowId,
      ...(typeof record.active === "boolean" ? { active: record.active } : {}),
      minimized: record.minimized === true,
      visible: record.visible !== false,
      ...(stackingIndex !== undefined ? { stackingIndex } : {}),
      ...(occludedBy ? { occludedBy } : {}),
    });
  }
  return windows;
}

// ── Workspace geometry ───────────────────────────────────────────────

/**
 * Resolves the global desktop rect. The display server's reported workspace
 * geometry is the source of truth; the window bounding box is the fallback for
 * a source that does not report it yet. Windows with no bounds contribute
 * nothing, which is the only honest thing an unlocatable window can do to a
 * bounding box.
 */
export function workspaceRectFromWindows(
  windows: readonly ComputerWindow[],
  workspace?: ComputerRect | null,
): ComputerRect {
  if (workspace && workspace.width > 0 && workspace.height > 0) {
    return {
      x: Math.floor(workspace.x),
      y: Math.floor(workspace.y),
      width: Math.max(1, Math.ceil(workspace.width)),
      height: Math.max(1, Math.ceil(workspace.height)),
    };
  }
  const bounds = windows
    .map((window) => window.bounds)
    .filter((rect): rect is ComputerRect => rect !== undefined);
  const left = Math.min(0, ...bounds.map((rect) => Math.floor(rect.x)));
  const top = Math.min(0, ...bounds.map((rect) => Math.floor(rect.y)));
  const right = Math.max(left + 1, ...bounds.map((rect) => Math.ceil(rect.x + rect.width)));
  const bottom = Math.max(top + 1, ...bounds.map((rect) => Math.ceil(rect.y + rect.height)));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * A window's rect, or a refusal that names why there is none.
 *
 * Absent bounds are a property of the display server, not of the window: under
 * wlroots' foreign-toplevel protocol no client can ask where a window is. Every
 * caller here needs a rect to do arithmetic on, and the alternatives are both
 * lies — treating the origin as the window's position puts a click on the wrong
 * monitor, and returning an empty capture tells a model the window is blank. So
 * the geometry-dependent paths refuse, and say which capability is missing so
 * the caller can pick a coordinate-based approach instead.
 */
export function requireWindowBounds(
  window: Pick<ComputerWindow, "id" | "bounds">,
  action: string,
): ComputerRect {
  if (window.bounds) return window.bounds;
  throw new ComputerBackendError(
    `This desktop reports no geometry for window ${JSON.stringify(window.id)}, so ${action} cannot be resolved. ` +
      "The display server exposes window titles and activation but no position or size " +
      "(capabilities.windowBounds is false); use full-screen capture and desktop coordinates instead.",
  );
}

export function screenSizeFromWindows(
  windows: readonly ComputerWindow[],
  workspace?: ComputerRect | null,
): ComputerScreenSize {
  const rect = workspaceRectFromWindows(windows, workspace);
  return { width: rect.width, height: rect.height, scale: 1 };
}

/**
 * Snaps a requested region onto whole logical pixels without losing coverage:
 * capture APIs take integers, so a fractional rect must grow outward instead of
 * cropping the edge the caller asked for.
 */
export function alignRect(rect: ComputerRect): ComputerRect {
  const x = Math.floor(rect.x);
  const y = Math.floor(rect.y);
  return {
    x,
    y,
    width: Math.max(1, Math.ceil(rect.x + rect.width) - x),
    height: Math.max(1, Math.ceil(rect.y + rect.height) - y),
  };
}

export function formatRect(rect: ComputerRect): string {
  return `${rect.width}x${rect.height} at (${rect.x}, ${rect.y})`;
}

// ── Capture ──────────────────────────────────────────────────────────

/**
 * Dimensions from a PNG's IHDR chunk, which is at a fixed offset in every
 * conformant file. Reading them from the encoding rather than assuming the
 * requested size is what keeps `scale` honest: a backend renders at the
 * output's device pixel ratio and only then downscales to `maxDimension`.
 *
 * `source` names the backend in the failure, because this message is what a
 * tool call and an availability card both end up showing.
 */
export function readPngDimensions(
  bytes: Uint8Array,
  options: { readonly source?: string } = {},
): { readonly width: number; readonly height: number } {
  const source = options.source ?? DEFAULT_CAPTURE_SOURCE;
  if (
    bytes.byteLength < 24 ||
    !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte) ||
    !PNG_IHDR.every((byte, index) => bytes[12 + index] === byte)
  ) {
    throw new ComputerBackendError(`${source} did not return a PNG image.`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width < 1 || height < 1) {
    throw new ComputerBackendError(`${source} has invalid dimensions.`);
  }
  return { width, height };
}

/**
 * The screenshot payload is only useful to a model when the desktop rect it
 * covers travels with it, so every capture path in every backend builds it the
 * same way: `desktop = region.origin + screenshot_pixel / scale`.
 */
export function screenshotFromPng(input: {
  readonly bytes: Uint8Array;
  readonly region: ComputerRect;
  readonly capturedAt: string;
  readonly source?: string;
}): ComputerScreenshot {
  const dimensions = readPngDimensions(
    input.bytes,
    input.source === undefined ? {} : { source: input.source },
  );
  return {
    mimeType: "image/png",
    width: dimensions.width,
    height: dimensions.height,
    sizeBytes: input.bytes.byteLength,
    bytesBase64: Buffer.from(input.bytes).toString("base64"),
    region: input.region,
    scale: dimensions.width / input.region.width,
    capturedAt: input.capturedAt,
  };
}
