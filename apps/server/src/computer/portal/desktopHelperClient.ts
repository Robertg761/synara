/**
 * The transport to `synara-computer-desktop-helper`, and the only module that
 * knows its wire protocol.
 *
 * Node cannot hold a `wl_display`, so every Wayland-native capability in Tier 2
 * — virtual pointer and keyboard, screencopy, foreign-toplevel enumeration —
 * is reached through one small C process. It speaks two channels, the same
 * shape the iOS device helper uses:
 *
 * - Control: newline-framed JSON-RPC 2.0 on stdin/stdout, plus a `ready`
 *   notification at startup carrying the compositor's global list.
 * - Frames: fd 3, `u32 little-endian length` then the shared frame envelope,
 *   carrying capture payloads. A full-desktop PNG through the JSON channel
 *   would be a third larger and would run the whole screenshot through a JSON
 *   parser twice a second, which is why it is a separate channel at all.
 *
 * Two facts shape callers. The channels are separate fds with **no ordering
 * guarantee between them**, so a capture waits for its payload by stream id
 * rather than assuming it arrived before the response. And a failed request
 * resets the process: the helper is stateless apart from the input it is
 * holding down, and the compositor releases a virtual device's held keys when
 * its client disconnects, so a restart cannot strand a modifier.
 */
import type { ComputerRect } from "@synara/contracts";

import { decodeFrameEnvelope } from "@synara/shared/frameTransport";
import {
  JsonRpcStdioFramer,
  JsonRpcStdioRequestRegistry,
  JsonRpcStdioTransportError,
  JsonRpcStdioWriter,
} from "@synara/shared/jsonrpc-stdio";
import {
  LengthPrefixedRecordError,
  LengthPrefixedRecordParser,
} from "@synara/shared/lengthPrefixedRecords";

import { ComputerBackendError } from "../ComputerBackend.ts";
import { asFiniteNumber, asRecord, asString, parseComputerRect } from "../computerGeometry.ts";
import {
  startSupervisedProcess,
  type SupervisedProcess,
  type SupervisedSpawn,
} from "../supervisedProcess.ts";

/** The fd the helper writes capture payloads to. */
const FRAME_FD = 3;
const HELPER_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const HELPER_MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const HELPER_REQUEST_TIMEOUT_MS = 10_000;
/** A capture waits longer: it is a compositor round trip plus PNG encoding. */
const HELPER_CAPTURE_TIMEOUT_MS = 15_000;
const HELPER_RECONNECT_BASE_DELAY_MS = 250;
const HELPER_RECONNECT_MAX_DELAY_MS = 5_000;
const HELPER_MAX_RECONNECT_FAILURES = 5;
/**
 * Payloads that arrived before their response. One is the normal case (the
 * helper writes the frame first); more than a handful means responses are being
 * lost, and holding them all would be an unbounded leak.
 */
const MAX_ORPHAN_PAYLOADS = 4;

/**
 * The helper's own JSON-RPC error codes, from `main.c`.
 *
 * The split is what tells a caller whether to try again. A compositor that does
 * not advertise `zwlr_screencopy_manager_v1` will not advertise it on the next
 * request either, while a capture that timed out or an output that was unplugged
 * mid-frame is a one-off. Neither kind restarts the process: both are the helper
 * answering correctly.
 */
const HELPER_ERROR_CODES = {
  /** -32000: the request was wrong. Retrying the same request is pointless. */
  invalid: -32000,
  /** -32001: this compositor can never serve it. */
  unsupported: -32001,
  /** -32002: it failed this once. */
  transient: -32002,
} as const;

/**
 * The helper's private frame channel: "HS", distinct from the computer frame
 * magic so a payload that reached the wrong pipe is rejected rather than
 * decoded. Exported because the C helper is the other implementer of this wire
 * and the transport tests stand in for it.
 */
export const DESKTOP_HELPER_FRAME_CODEC = {
  magic: 0x5348,
  version: 1,
  streamIdLabel: "captureId",
  frameLabel: "Desktop helper",
} as const;

export const DESKTOP_HELPER_METHODS = {
  globals: "globals",
  outputs: "outputs",
  pointerMotion: "pointerMotion",
  pointerButton: "pointerButton",
  scroll: "scroll",
  key: "key",
  releaseAll: "releaseAll",
  capture: "capture",
  listWindows: "listWindows",
  activateWindow: "activateWindow",
  closeWindow: "closeWindow",
} as const;

/** One output in desktop logical coordinates, the space pointer events use. */
export interface DesktopHelperOutput {
  readonly name: string;
  readonly rect: ComputerRect;
  /** Physical pixels per logical pixel, which fractional scaling makes non-integer. */
  readonly scale: number;
}

export interface DesktopHelperOutputs {
  readonly outputs: readonly DesktopHelperOutput[];
  /** The union of every output. */
  readonly workspace: ComputerRect;
}

/**
 * A toplevel as the foreign-toplevel protocol reports it: identity, activation,
 * and nothing about geometry, because a Wayland client cannot ask.
 */
export interface DesktopHelperWindow {
  readonly id: string;
  readonly title: string;
  readonly appId: string;
  readonly activated: boolean;
  readonly minimized: boolean;
  readonly maximized: boolean;
  readonly fullscreen: boolean;
}

export interface DesktopHelperCapture {
  /** PNG bytes, already cropped and scaled by the helper. */
  readonly bytes: Uint8Array;
  /** The desktop rect the pixels cover: the request clipped to the outputs. */
  readonly region: ComputerRect;
}

export interface DesktopHelperCaptureRequest {
  readonly region: ComputerRect;
  readonly maxDimension: number;
  readonly overlayCursor?: boolean;
}

/**
 * What the providers depend on. An interface rather than the class so every
 * provider is unit-testable against a fake helper, with the real process
 * exercised end to end by the headless-compositor lane.
 */
export interface DesktopHelperTransport {
  /** Wayland globals the compositor advertises, as reported by the live helper. */
  globals(): Promise<readonly string[]>;
  outputs(): Promise<DesktopHelperOutputs>;
  pointerMotion(x: number, y: number): Promise<void>;
  pointerButton(code: number, pressed: boolean): Promise<void>;
  scroll(deltaX: number, deltaY: number): Promise<void>;
  key(code: number, pressed: boolean): Promise<void>;
  /** Releases everything the helper is holding down. Never rejects on a dead helper. */
  releaseAll(): Promise<void>;
  capture(request: DesktopHelperCaptureRequest): Promise<DesktopHelperCapture>;
  listWindows(): Promise<readonly DesktopHelperWindow[]>;
  activateWindow(id: string): Promise<void>;
  closeWindow(id: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface DesktopHelperClientOptions {
  /** Absolute path of the built helper, from `desktopHelperPath()`. */
  readonly command: string;
  /**
   * The helper's environment. It must carry the session's `WAYLAND_DISPLAY` and
   * `XDG_RUNTIME_DIR`; a nested session hands its own here, which is how the
   * same client drives an isolated compositor.
   */
  readonly env?: NodeJS.ProcessEnv;
  readonly requestTimeoutMs?: number;
  readonly captureTimeoutMs?: number;
  readonly spawnProcess?: SupervisedSpawn;
}

interface PendingCapture {
  readonly resolve: (payload: Uint8Array) => void;
  readonly reject: (error: Error) => void;
}

/**
 * Supervises one helper process.
 *
 * Restart policy mirrors the AT-SPI client: a failed request tears the process
 * down and the next one starts a fresh one after `250ms * 2^failures`, capped
 * at five seconds. That is the right shape here for the same reason it is
 * there — a helper that failed once will fail the same way immediately, and a
 * hot restart loop against a compositor that is shutting down would be
 * indistinguishable from a busy loop.
 */
export class DesktopHelperClient implements DesktopHelperTransport {
  private process: SupervisedProcess | null = null;
  private framer: JsonRpcStdioFramer | null = null;
  private writer: JsonRpcStdioWriter | null = null;
  private registry: JsonRpcStdioRequestRegistry | null = null;
  private frames: LengthPrefixedRecordParser | null = null;
  private readonly pendingCaptures = new Map<string, PendingCapture>();
  private readonly orphanPayloads = new Map<string, Uint8Array>();
  private readonly requestTimeoutMs: number;
  private readonly captureTimeoutMs: number;
  private reconnectFailures = 0;
  private startPromise: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly options: DesktopHelperClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? HELPER_REQUEST_TIMEOUT_MS;
    this.captureTimeoutMs = options.captureTimeoutMs ?? HELPER_CAPTURE_TIMEOUT_MS;
  }

  async globals(): Promise<readonly string[]> {
    const result = asRecord(await this.request(DESKTOP_HELPER_METHODS.globals, {}));
    return parseGlobals(result.globals);
  }

  async outputs(): Promise<DesktopHelperOutputs> {
    const result = asRecord(await this.request(DESKTOP_HELPER_METHODS.outputs, {}));
    const workspace = parseRect(result.workspace);
    if (!workspace) {
      throw new ComputerBackendError(
        "The desktop helper reported no workspace rect, so the desktop has no coordinate space to work in.",
      );
    }
    const outputs = Array.isArray(result.outputs)
      ? result.outputs.flatMap((entry) => {
          const record = asRecord(entry);
          const rect = parseRect(entry);
          if (!rect) return [];
          return [
            {
              name: asString(record.name) ?? "",
              rect,
              scale: asFiniteNumber(record.scale) ?? 1,
            } satisfies DesktopHelperOutput,
          ];
        })
      : [];
    return { outputs, workspace };
  }

  async pointerMotion(x: number, y: number): Promise<void> {
    await this.request(DESKTOP_HELPER_METHODS.pointerMotion, { x, y });
  }

  async pointerButton(code: number, pressed: boolean): Promise<void> {
    await this.request(DESKTOP_HELPER_METHODS.pointerButton, { code, pressed });
  }

  async scroll(deltaX: number, deltaY: number): Promise<void> {
    await this.request(DESKTOP_HELPER_METHODS.scroll, { deltaX, deltaY });
  }

  async key(code: number, pressed: boolean): Promise<void> {
    await this.request(DESKTOP_HELPER_METHODS.key, { code, pressed });
  }

  /**
   * Best-effort by design: this runs on the disposal path, where the helper may
   * already be gone, and a rejection there would mask the reason it went.
   */
  async releaseAll(): Promise<void> {
    if (this.process === null) return;
    try {
      await this.request(DESKTOP_HELPER_METHODS.releaseAll, {});
    } catch {
      // The process is already gone, which released the virtual devices anyway.
    }
  }

  async capture(request: DesktopHelperCaptureRequest): Promise<DesktopHelperCapture> {
    const result = asRecord(
      await this.request(
        DESKTOP_HELPER_METHODS.capture,
        {
          x: Math.round(request.region.x),
          y: Math.round(request.region.y),
          width: Math.round(request.region.width),
          height: Math.round(request.region.height),
          maxDimension: Math.round(request.maxDimension),
          overlayCursor: request.overlayCursor === true,
        },
        this.captureTimeoutMs,
      ),
    );
    const streamId = asString(result.streamId);
    const region = parseRect(result.region);
    if (!streamId || !region) {
      throw new ComputerBackendError(
        "The desktop helper answered a capture without a stream id and region, so its payload cannot be matched.",
      );
    }
    const bytes = await this.awaitPayload(streamId);
    return { bytes, region };
  }

  async listWindows(): Promise<readonly DesktopHelperWindow[]> {
    const result = asRecord(await this.request(DESKTOP_HELPER_METHODS.listWindows, {}));
    if (!Array.isArray(result.windows)) {
      throw new ComputerBackendError(
        "The desktop helper answered a window list without a windows array.",
      );
    }
    return result.windows.flatMap((entry) => {
      const record = asRecord(entry);
      const id = asString(record.id);
      if (!id) return [];
      return [
        {
          id,
          title: asString(record.title) ?? "",
          appId: asString(record.appId) ?? "",
          activated: record.activated === true,
          minimized: record.minimized === true,
          maximized: record.maximized === true,
          fullscreen: record.fullscreen === true,
        } satisfies DesktopHelperWindow,
      ];
    });
  }

  async activateWindow(id: string): Promise<void> {
    await this.request(DESKTOP_HELPER_METHODS.activateWindow, { id });
  }

  async closeWindow(id: string): Promise<void> {
    await this.request(DESKTOP_HELPER_METHODS.closeWindow, { id });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.releaseAll();
    const error = new ComputerBackendError("The desktop helper was disposed.");
    this.teardown(error, { restartable: false });
    await this.startPromise?.catch(() => undefined);
    this.startPromise = null;
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<unknown> {
    if (this.disposed) {
      throw new ComputerBackendError("The desktop helper is disposed.", { retryable: false });
    }
    await this.ensureStarted();
    const registry = this.registry;
    const writer = this.writer;
    if (!registry || !writer) {
      throw new ComputerBackendError("The desktop helper transport is unavailable.");
    }
    try {
      const result = await registry.request(
        method,
        params,
        (message) => writer.write(message),
        timeoutMs,
      );
      this.reconnectFailures = 0;
      return result;
    } catch (error) {
      // A method the compositor cannot serve — no screencopy, no
      // foreign-toplevel — is the helper answering correctly, not a broken
      // transport, so the process is left alone and the refusal is passed
      // through with its own sentence intact. Whether the caller may try again
      // is the helper's answer to give, and it gives it in the error code.
      if (error instanceof HelperMethodError) {
        throw new ComputerBackendError(error.message, {
          retryable: error.retryable,
          cause: error,
        });
      }
      const failure = this.describeFailure(method, error);
      this.teardown(failure, { restartable: true });
      throw failure;
    }
  }

  private describeFailure(method: string, error: unknown): ComputerBackendError {
    const detail = error instanceof Error ? error.message : String(error);
    const diagnostic = this.process?.diagnostic() ?? "";
    const exit = this.process?.exitDiagnostic();
    return new ComputerBackendError(
      `The desktop helper failed to answer ${method}: ${detail}.` +
        (exit ? ` The helper had exited (${exit}).` : "") +
        diagnostic,
      { cause: error },
    );
  }

  private async ensureStarted(): Promise<void> {
    if (this.process !== null && this.registry !== null && this.writer !== null) return;
    if (this.startPromise) return this.startPromise;

    const delayMs =
      this.reconnectFailures === 0
        ? 0
        : Math.min(
            HELPER_RECONNECT_MAX_DELAY_MS,
            HELPER_RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectFailures,
          );
    const wait =
      delayMs === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delayMs);
            timer.unref?.();
          });
    this.startPromise = wait
      .then(() => {
        if (this.disposed) return;
        this.startProcess();
      })
      .finally(() => {
        this.startPromise = null;
      });
    await this.startPromise;
  }

  private startProcess(): void {
    const child = startSupervisedProcess({
      command: this.options.command,
      args: [],
      env: { ...process.env, ...this.options.env },
      // stdin and fd 3 on top of the default layout: the control channel is
      // bidirectional and capture payloads need their own pipe.
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      ...(this.options.spawnProcess ? { spawnProcess: this.options.spawnProcess } : {}),
    });
    const stdin = child.stdin;
    const stdout = child.stdout;
    const frameStream = child.extraStream(FRAME_FD);
    if (!stdin || !stdout || !frameStream) {
      void child.terminate();
      throw new ComputerBackendError(
        `${this.options.command} was started without the pipes its protocol needs ` +
          "(stdin, stdout, and the fd 3 frame channel).",
      );
    }

    this.process = child;
    this.framer = new JsonRpcStdioFramer(HELPER_MAX_FRAME_BYTES);
    this.writer = new JsonRpcStdioWriter(stdin, HELPER_MAX_FRAME_BYTES);
    this.frames = new LengthPrefixedRecordParser(HELPER_MAX_CAPTURE_BYTES);
    this.registry = new JsonRpcStdioRequestRegistry({
      requestTimeoutMs: this.requestTimeoutMs,
      includeJsonRpcVersion: true,
      responseError: ({ error }) =>
        new HelperMethodError(
          typeof error.message === "string"
            ? error.message
            : "the desktop helper refused the request",
          typeof error.code === "number" ? error.code : undefined,
        ),
    });
    this.registry.processStarted();
    stdout.on("data", (chunk: Buffer) => this.consumeStdout(chunk));
    (frameStream as NodeJS.ReadableStream).on("data", (chunk: Buffer) => this.consumeFrames(chunk));
    // A helper that dies holding a request must fail it now, with the reason it
    // died, rather than leaving the caller to wait out the request timeout for
    // an answer no process is left to give.
    void child.whenExited().then((reason) => {
      if (this.process !== child) return;
      this.teardown(
        new ComputerBackendError(`The desktop helper exited (${reason}).${child.diagnostic()}`),
        { restartable: true },
      );
    });
  }

  private consumeStdout(chunk: Buffer): void {
    const framer = this.framer;
    if (!framer) return;
    try {
      for (const line of framer.push(chunk)) {
        const message = asRecord(parseJson(line));
        if (!("id" in message)) continue; // the `ready` notification
        const id = message.id;
        if (typeof id !== "number" && typeof id !== "string") continue;
        const error = isRecord(message.error) ? message.error : undefined;
        this.registry?.handleResponse({
          id,
          result: message.result,
          ...(error
            ? {
                error: {
                  ...(typeof error.code === "number" ? { code: error.code } : {}),
                  ...(typeof error.message === "string" ? { message: error.message } : {}),
                },
              }
            : {}),
        });
      }
    } catch (error) {
      if (error instanceof JsonRpcStdioTransportError) {
        this.teardown(
          new ComputerBackendError(
            `The desktop helper's control channel desynced: ${error.message}`,
          ),
          { restartable: true },
        );
      }
    }
  }

  private consumeFrames(chunk: Buffer): void {
    const frames = this.frames;
    if (!frames) return;
    let records: readonly Uint8Array[];
    try {
      records = frames.push(chunk);
    } catch (error) {
      // A desynced frame stream cannot resynchronize: the length that would
      // find the next record is the one that is wrong.
      this.teardown(
        new ComputerBackendError(
          `The desktop helper's capture channel desynced: ${
            error instanceof LengthPrefixedRecordError ? error.message : String(error)
          }`,
        ),
        { restartable: true },
      );
      return;
    }
    for (const record of records) {
      const decoded = decodeFrameEnvelope(DESKTOP_HELPER_FRAME_CODEC, record);
      if (!decoded.ok) continue;
      const streamId = decoded.frame.header.streamId;
      const pending = this.pendingCaptures.get(streamId);
      if (pending) {
        this.pendingCaptures.delete(streamId);
        pending.resolve(decoded.frame.payload);
        continue;
      }
      // The frame usually beats its response out of the helper, so an
      // unmatched payload is held briefly rather than dropped.
      this.orphanPayloads.set(streamId, decoded.frame.payload);
      while (this.orphanPayloads.size > MAX_ORPHAN_PAYLOADS) {
        const oldest = this.orphanPayloads.keys().next();
        if (oldest.done) break;
        this.orphanPayloads.delete(oldest.value);
      }
    }
  }

  /**
   * Waits for the payload belonging to a capture response.
   *
   * Two fds have no ordering guarantee between them, so both orders are
   * handled: the payload may already be waiting, or the response may have won
   * the race and the payload is still in flight.
   */
  private awaitPayload(streamId: string): Promise<Uint8Array> {
    const ready = this.orphanPayloads.get(streamId);
    if (ready) {
      this.orphanPayloads.delete(streamId);
      return Promise.resolve(ready);
    }
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCaptures.delete(streamId);
        reject(
          new ComputerBackendError(
            `The desktop helper acknowledged a screen capture but its image never arrived within ${this.captureTimeoutMs} ms.`,
            { retryable: true },
          ),
        );
      }, this.captureTimeoutMs);
      timer.unref?.();
      this.pendingCaptures.set(streamId, {
        resolve: (payload) => {
          clearTimeout(timer);
          resolve(payload);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  /** Drops the process and fails everything waiting on it with one reason. */
  private teardown(error: Error, options: { readonly restartable: boolean }): void {
    const child = this.process;
    // An exit and the request failure it causes both land here. Only the first
    // one lost a process, and counting the second would double the backoff the
    // next request waits out.
    const live = child !== null || this.registry !== null;
    this.process = null;
    this.framer?.close();
    this.writer?.close(error);
    this.registry?.processExited(error);
    this.framer = null;
    this.writer = null;
    this.registry = null;
    this.frames = null;
    for (const pending of this.pendingCaptures.values()) pending.reject(error);
    this.pendingCaptures.clear();
    this.orphanPayloads.clear();
    if (options.restartable && live) {
      this.reconnectFailures = Math.min(this.reconnectFailures + 1, HELPER_MAX_RECONNECT_FAILURES);
    }
    void child?.terminate();
  }
}

/**
 * A JSON-RPC error the helper returned, as opposed to a transport failure.
 *
 * The distinction decides whether the process is restarted: "this compositor
 * does not advertise zwlr_screencopy_manager_v1" is a correct answer that will
 * be just as true after a restart, and restarting on it would turn one refusal
 * into a spawn loop.
 */
class HelperMethodError extends Error {
  readonly code: number | undefined;

  constructor(message: string, code?: number) {
    super(message);
    this.name = "HelperMethodError";
    this.code = code;
  }

  /**
   * Only a transient refusal is worth trying again, and only by the caller —
   * the process is fine either way.
   */
  get retryable(): boolean {
    return this.code === HELPER_ERROR_CODES.transient;
  }
}

/**
 * Splits ownership of one helper between the providers that share it.
 *
 * Input, capture, and windows are three provider slots over a single Wayland
 * connection, and the backend disposes each slot independently. Neither
 * alternative works: disposing the helper from any one provider would kill
 * capture when input goes away, and disposing from none would leave a process
 * attached to the compositor for the server's lifetime.
 *
 * Returns one release function per user, each idempotent, with the helper
 * disposed when the last of them has been called.
 */
export function shareDesktopHelper(
  helper: Pick<DesktopHelperTransport, "dispose">,
  users: number,
): readonly (() => Promise<void>)[] {
  let outstanding = users;
  let disposal: Promise<void> | null = null;
  const release = (): Promise<void> => {
    outstanding -= 1;
    if (outstanding > 0) return Promise.resolve();
    disposal ??= helper.dispose();
    return disposal;
  };
  return Array.from({ length: Math.max(0, users) }, () => {
    let released = false;
    return () => {
      if (released) return disposal ?? Promise.resolve();
      released = true;
      return release();
    };
  });
}

/**
 * Asks a freshly spawned helper for the compositor's globals and lets it exit.
 *
 * Deliberately a short-lived invocation rather than the supervised client: the
 * probe runs at server boot on desktops that may have no wlroots protocols at
 * all, and leaving a helper process attached to the compositor for the whole
 * server lifetime to answer one question would be a resource the feature has
 * not earned yet.
 */
export function readWaylandGlobals(options: {
  readonly command: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly spawnProcess?: SupervisedSpawn;
}): Promise<readonly string[]> {
  const child = startSupervisedProcess({
    command: options.command,
    args: ["--print-globals"],
    env: { ...process.env, ...options.env },
    ...(options.spawnProcess ? { spawnProcess: options.spawnProcess } : {}),
  });
  return child
    .readFirstStdoutLine(options.timeoutMs ?? HELPER_REQUEST_TIMEOUT_MS)
    .then((line) => parseGlobals(asRecord(parseJson(line)).globals))
    .finally(() => child.terminate());
}

function parseGlobals(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new ComputerBackendError(
      "The desktop helper reported no Wayland global list, so the compositor's protocols are unknown.",
    );
  }
  return value.flatMap((entry) => {
    const name = asString(asRecord(entry).interface);
    return name ? [name] : [];
  });
}

/** A rect that covers pixels. A zero-area rect is not a region anything can use. */
function parseRect(value: unknown): ComputerRect | undefined {
  const rect = parseComputerRect(value);
  return rect && rect.width > 0 && rect.height > 0 ? rect : undefined;
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
