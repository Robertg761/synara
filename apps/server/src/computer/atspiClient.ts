import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  JsonRpcStdioFramer,
  JsonRpcStdioRequestRegistry,
  JsonRpcStdioTransportError,
  JsonRpcStdioWriter,
} from "@synara/shared/jsonrpc-stdio";

import type { ComputerWindow } from "@synara/contracts";
import type { AtspiWindowTree } from "./atspiTreeTargeting.ts";

const HELPER_METHOD = "read-tree";
const HELPER_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const HELPER_REQUEST_TIMEOUT_MS = 10_000;
const HELPER_RECONNECT_BASE_DELAY_MS = 250;
const HELPER_RECONNECT_MAX_DELAY_MS = 5_000;

export interface AtspiTreeReader {
  readonly readTrees: (windows: readonly ComputerWindow[]) => Promise<readonly AtspiWindowTree[]>;
  readonly dispose: () => Promise<void>;
}

export interface AtspiHelperClientOptions {
  readonly pythonPath?: string;
  readonly scriptPath?: string;
  readonly requestTimeoutMs?: number;
  readonly spawnProcess?: (
    command: string,
    args: readonly string[],
  ) => ChildProcessWithoutNullStreams;
}

/**
 * Supervises the small PyGObject AT-SPI reader. The helper is deliberately
 * stateless: a crashed process loses only one perception request and the next
 * request starts a fresh process after a bounded backoff.
 */
export class AtspiHelperClient implements AtspiTreeReader {
  private process: ChildProcessWithoutNullStreams | null = null;
  private framer: JsonRpcStdioFramer | null = null;
  private writer: JsonRpcStdioWriter | null = null;
  private registry: JsonRpcStdioRequestRegistry | null = null;
  private readonly requestTimeoutMs: number;
  private reconnectFailures = 0;
  private startPromise: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly options: AtspiHelperClientOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? HELPER_REQUEST_TIMEOUT_MS;
  }

  async readTrees(windows: readonly ComputerWindow[]): Promise<readonly AtspiWindowTree[]> {
    if (windows.length === 0) return [];
    const result = await this.request(HELPER_METHOD, {
      windows: windows.map((window) => ({
        id: window.id,
        title: window.title,
        appName: window.appName ?? null,
        pid: window.pid ?? null,
        bounds: window.bounds,
      })),
    });
    if (!isRecord(result) || !Array.isArray(result.trees)) {
      throw new Error("AT-SPI helper returned no tree list.");
    }
    return result.trees.filter(isAtspiWindowTree);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const process = this.process;
    this.process = null;
    this.framer?.close();
    this.writer?.close(new Error("AT-SPI helper disposed"));
    this.registry?.processExited(new Error("AT-SPI helper disposed"));
    this.framer = null;
    this.writer = null;
    this.registry = null;
    process?.stdin.end();
    process?.kill("SIGTERM");
    await this.startPromise?.catch(() => undefined);
    this.startPromise = null;
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.disposed) throw new Error("AT-SPI helper is disposed.");
    await this.ensureStarted();
    const registry = this.registry;
    const writer = this.writer;
    if (!registry || !writer) throw new Error("AT-SPI helper transport is unavailable.");
    try {
      const result = await registry.request(
        method,
        params,
        (message) => writer.write(message),
        this.requestTimeoutMs,
      );
      this.reconnectFailures = 0;
      return result;
    } catch (error) {
      this.resetProcess(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.process !== null && this.registry !== null && this.writer !== null) return;
    if (this.startPromise) return this.startPromise;

    const delay =
      this.reconnectFailures === 0
        ? 0
        : Math.min(
            HELPER_RECONNECT_MAX_DELAY_MS,
            HELPER_RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectFailures,
          );
    const wait =
      delay === 0 ? Promise.resolve() : new Promise<void>((resolve) => setTimeout(resolve, delay));
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
    const command = this.options.pythonPath ?? process.env.SYNARA_ATSPI_PYTHON ?? "python3";
    const scriptPath =
      this.options.scriptPath ??
      process.env.SYNARA_ATSPI_HELPER ??
      fileURLToPath(new URL("./atspi_helper.py", import.meta.url));
    const spawnProcess =
      this.options.spawnProcess ??
      ((spawnCommand, args) =>
        spawn(spawnCommand, args, {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, PYTHONUNBUFFERED: "1" },
        }));
    const child = spawnProcess(command, ["-u", scriptPath]);
    this.process = child;
    this.framer = new JsonRpcStdioFramer(HELPER_MAX_FRAME_BYTES);
    this.writer = new JsonRpcStdioWriter(child.stdin, HELPER_MAX_FRAME_BYTES);
    this.registry = new JsonRpcStdioRequestRegistry({
      requestTimeoutMs: this.requestTimeoutMs,
      includeJsonRpcVersion: true,
      responseError: ({ error }) =>
        new Error(
          typeof error.message === "string" ? error.message : "AT-SPI helper request failed",
        ),
    });
    this.registry.processStarted();
    child.stdout.on("data", (chunk: Buffer) => this.consumeStdout(chunk));
    child.stderr.resume();
    child.on("error", (error) => this.resetProcess(error));
    child.on("exit", (code, signal) => {
      if (this.process !== child) return;
      this.resetProcess(
        new Error(`AT-SPI helper exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`),
      );
    });
  }

  private consumeStdout(chunk: Buffer): void {
    const framer = this.framer;
    if (!framer) return;
    try {
      for (const line of framer.push(chunk)) {
        const message = parseJson(line);
        if (!isRecord(message) || !("id" in message)) continue;
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
      if (error instanceof JsonRpcStdioTransportError) this.resetProcess(error);
    }
  }

  private resetProcess(error: Error): void {
    const child = this.process;
    this.process = null;
    this.framer?.close();
    this.writer?.close(error);
    this.registry?.processExited(error);
    this.framer = null;
    this.writer = null;
    this.registry = null;
    this.reconnectFailures = Math.min(this.reconnectFailures + 1, 5);
    if (child && !child.killed) child.kill("SIGTERM");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function isAtspiWindowTree(value: unknown): value is AtspiWindowTree {
  if (!isRecord(value)) return false;
  return (
    typeof value.windowId === "string" && isClientSize(value.clientSize) && isAtspiNode(value.root)
  );
}

function isClientSize(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.width === "number" &&
    Number.isFinite(value.width) &&
    value.width > 0 &&
    typeof value.height === "number" &&
    Number.isFinite(value.height) &&
    value.height > 0
  );
}

function isAtspiNode(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.role === "string" &&
    (value.label === null || typeof value.label === "string") &&
    (value.value === null || typeof value.value === "string") &&
    (value.description === null || typeof value.description === "string") &&
    isRect(value.frame) &&
    Array.isArray(value.children) &&
    value.children.every(isAtspiNode)
  );
}

function isRect(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y) &&
    typeof value.width === "number" &&
    Number.isFinite(value.width) &&
    value.width >= 0 &&
    typeof value.height === "number" &&
    Number.isFinite(value.height) &&
    value.height >= 0
  );
}
