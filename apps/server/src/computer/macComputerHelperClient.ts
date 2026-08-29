/**
 * MacComputerHelperClient — the only module that knows the native macOS
 * computer-use helper's wire protocol.
 *
 * The helper is a Swift process compiled on demand against the user's Xcode
 * (it resolves private Quartz/AppKit SPI at runtime — `CGEventSetWindowLocation`
 * and friends — so it cannot ship a prebuilt binary that would break between
 * OS releases), mirroring the device helper. It speaks one channel:
 *
 * - Control: newline-delimited JSON-RPC 2.0 over stdin/stdout. Requests carry
 *   an integer id; responses carry `result` or `error`. It also emits a `ready`
 *   notification at startup.
 *
 * Unlike the iOS device helper there is no frame socket: Tier-1 macOS capture
 * is a whole-desktop PNG still, and the backend publishes those on a timer the
 * same way the KWin backend does, so a burst of video can never share a pipe
 * with a command response because there is no video pipe at all.
 *
 * This reuses the shared `@synara/shared/jsonrpc-stdio` transport primitives —
 * the same ones the Codex app-server and device helper are built on — so the
 * framing, request correlation, and timeout logic are not a third copy.
 *
 * @module computer/macComputerHelperClient
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  JsonRpcStdioFramer,
  JsonRpcStdioRequestRegistry,
  JsonRpcStdioTransportError,
  JsonRpcStdioWriter,
} from "@synara/shared/jsonrpc-stdio";

/** The methods the Swift helper serves. Kept in one place so the backend and its tests agree. */
export const MAC_HELPER_METHODS = {
  ping: "ping",
  capabilities: "capabilities",
  listWindows: "list-windows",
  screenSize: "screen-size",
  describeUi: "describe-ui",
  capture: "capture",
  launchApp: "launch-app",
  move: "move",
  click: "click",
  doubleClick: "double-click",
  rightClick: "right-click",
  drag: "drag",
  scroll: "scroll",
  type: "type",
  pressKey: "press-key",
  hotkey: "hotkey",
  setValue: "set-value",
  performAction: "perform-action",
  raiseWindow: "raise-window",
  readClipboard: "read-clipboard",
  writeClipboard: "write-clipboard",
  setAgentCursor: "set-agent-cursor",
} as const;

/** A long turn can hold the helper (a slow AX walk, a Screen Recording prompt), so the default is generous. */
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_CONTROL_LINE_BYTES = 4 * 1024 * 1024;

export class MacComputerHelperError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "MacComputerHelperError";
    this.code = code;
  }
}

/**
 * The slice of a helper client the backend depends on. Narrowed to an interface
 * so a test can substitute a scripted transport without a real process, the way
 * the KWin backend takes an injectable D-Bus surface.
 */
export interface MacHelperTransport {
  readonly running: boolean;
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  dispose(): Promise<void>;
}

export interface MacComputerHelperClientOptions {
  readonly binaryPath: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly requestTimeoutMs?: number;
  readonly onExit?: (reason: string) => void;
  /**
   * Spawns the child. Injected so a test can stand in a fake process without a
   * real binary on disk; production passes nothing and gets `child_process.spawn`.
   */
  readonly spawn?: (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => ChildProcessWithoutNullStreams;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Owns one helper process: spawn, JSON-RPC over stdio, and the stderr tail that
 * turns a helper crash into a diagnosable failure message rather than a bare
 * exit code. There is no per-attachment state — a macOS desktop has no "attach"
 * step, every call names its own target — so this is thinner than the device
 * helper client.
 */
export class MacComputerHelperClient implements MacHelperTransport {
  private process: ChildProcessWithoutNullStreams | null = null;
  private stdoutFramer: JsonRpcStdioFramer | null = null;
  private stdinWriter: JsonRpcStdioWriter | null = null;
  private requestRegistry: JsonRpcStdioRequestRegistry | null = null;
  private readonly requestTimeoutMs: number;
  private stderrTail = "";
  private exited = false;

  constructor(private readonly options: MacComputerHelperClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  get running(): boolean {
    return this.process !== null && !this.exited;
  }

  start(): void {
    if (this.process) return;
    const spawnFn =
      this.options.spawn ??
      ((command, args, env) => spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], env }));
    const child = spawnFn(
      this.options.binaryPath,
      this.options.args ?? [],
      this.options.env ?? process.env,
    );
    this.process = child;
    this.exited = false;
    this.stdoutFramer = new JsonRpcStdioFramer(MAX_CONTROL_LINE_BYTES, (error) =>
      this.handleControlLineError(error),
    );
    this.stdinWriter = new JsonRpcStdioWriter(child.stdin);
    this.requestRegistry = new JsonRpcStdioRequestRegistry({
      requestTimeoutMs: this.requestTimeoutMs,
      includeJsonRpcVersion: true,
      timeoutError: (method) =>
        new MacComputerHelperError("helper_timeout", `Computer helper ${method} timed out.`),
      responseError: ({ error }) =>
        new MacComputerHelperError(
          typeof error.code === "number" ? `helper_${error.code}` : "helper_error",
          typeof error.message === "string" ? error.message : "Computer helper reported an error",
        ),
    });
    this.requestRegistry.processStarted();

    child.stdout.on("data", (chunk: Buffer) => this.consumeStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // Keep only a tail: helper diagnostics belong in the failure message but
      // must never grow without bound over a long-lived session.
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4_096);
    });
    child.on("error", (error) =>
      this.fail(new MacComputerHelperError("helper_spawn_failed", error.message)),
    );
    child.on("exit", (code, signal) => {
      this.exited = true;
      const reason = `computer helper exited (code=${code ?? "null"}, signal=${signal ?? "null"})${
        this.stderrTail.trim() ? `: ${this.stderrTail.trim()}` : ""
      }`;
      this.fail(new MacComputerHelperError("helper_exited", reason));
      this.options.onExit?.(reason);
    });
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.process) this.start();
    const child = this.process;
    if (!child || this.exited) {
      throw new MacComputerHelperError("helper_unavailable", "Computer helper is not running");
    }
    const registry = this.requestRegistry;
    const writer = this.stdinWriter;
    if (!registry || !writer) {
      throw new MacComputerHelperError(
        "helper_unavailable",
        "Computer helper transport is not ready",
      );
    }
    try {
      return await registry.request(method, params, (message) => writer.write(message));
    } catch (error) {
      if (error instanceof MacComputerHelperError) throw error;
      throw new MacComputerHelperError(
        "helper_write_failed",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
  }

  async dispose(): Promise<void> {
    this.fail(new MacComputerHelperError("helper_disposed", "Computer helper was shut down"));
    const child = this.process;
    this.process = null;
    this.exited = true;
    child?.stdin.end();
    child?.kill("SIGTERM");
  }

  // ── Internals ──────────────────────────────────────────────────────

  private consumeStdout(chunk: Buffer): void {
    const framer = this.stdoutFramer;
    if (!framer) return;
    try {
      for (const line of framer.push(chunk)) {
        const trimmed = line.trim();
        if (trimmed.length > 0) this.handleControlLine(trimmed);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.rejectInFlight(
        new MacComputerHelperError("helper_protocol_error", message, { cause: error }),
      );
    }
  }

  private handleControlLineError(error: JsonRpcStdioTransportError): void {
    if (error.reason !== "frame-too-large") return;
    this.rejectInFlight(
      new MacComputerHelperError(
        "helper_protocol_error",
        "Computer helper control line exceeded limit",
        { cause: error },
      ),
    );
  }

  private handleControlLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // Helper logs that are not JSON are ignored, same as the device helper.
      return;
    }
    const record = asRecord(message);
    // Notifications (`ready`, diagnostics) carry no id and need no reply.
    if (typeof record.id !== "number") return;
    const error =
      record.error === undefined || record.error === null ? undefined : asRecord(record.error);
    this.requestRegistry?.handleResponse({
      id: record.id,
      result: record.result ?? null,
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

  private rejectInFlight(error: MacComputerHelperError): void {
    this.requestRegistry?.rejectAll(error);
  }

  private fail(error: MacComputerHelperError): void {
    this.requestRegistry?.processExited(error);
    this.stdinWriter?.close(error);
  }
}
