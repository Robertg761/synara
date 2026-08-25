// FILE: codexAppServer.ts
// Purpose: Polls a long-lived `codex app-server` child for provider-native threads.
// Layer: Session-sync provider discovery
//
// The daemon deliberately speaks to codex's own JSON-RPC surface instead of
// reading its storage files: the on-disk layout has already changed once
// (rollout JSONL -> SQLite state), while `thread/list` is the stable contract
// every GUI (Synara, T3 Code, the CLI) consumes through the same server.

import { spawn } from "node:child_process";

export interface CodexThreadRow {
  readonly id: string;
  readonly cwd: string | null;
  readonly title: string | null;
  readonly updatedAtMs: number | null;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (cause: Error) => void;
}

type JsonRpcMessage = {
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

function firstUserText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const part of value) {
      if (
        part &&
        typeof part === "object" &&
        "text" in part &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return (part as { text: string }).text;
      }
    }
  }
  return null;
}

/** Tolerant row mapping: codex may evolve field names; missing pieces degrade to null. */
export function mapCodexThreadRow(raw: unknown): CodexThreadRow | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = record["id"];
  if (typeof id !== "string" || id.length === 0) return null;

  const cwd = typeof record["cwd"] === "string" && record["cwd"].length > 0 ? record["cwd"] : null;

  const titleSource =
    typeof record["title"] === "string" && record["title"].trim().length > 0
      ? record["title"]
      : typeof record["preview"] === "string" && record["preview"].trim().length > 0
        ? record["preview"]
        : firstUserText(record["firstUserMessage"]);
  const title = titleSource === null ? null : titleSource.trim();

  const updatedCandidate = record["updatedAtMs"] ?? record["updated_at_ms"] ?? record["updatedAt"];
  let updatedAtMs: number | null = null;
  if (typeof updatedCandidate === "number") {
    updatedAtMs = updatedCandidate < 10_000_000_000 ? updatedCandidate * 1000 : updatedCandidate;
  } else if (typeof updatedCandidate === "string") {
    const parsed = Date.parse(updatedCandidate);
    if (Number.isFinite(parsed)) updatedAtMs = parsed;
  }

  return { id, cwd, title, updatedAtMs };
}

export class CodexAppServerPoller {
  private child: ReturnType<typeof spawn> | null = null;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = "";
  private stderrTail: string[] = [];

  constructor(private readonly binaryPath: string) {}

  async ensureRunning(): Promise<void> {
    if (this.child && this.child.exitCode === null) return;
    await this.start();
  }

  private start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binaryPath, ["app-server"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      this.pending = new Map();
      this.buffer = "";

      child.once("error", reject);
      child.once("exit", () => {
        for (const request of this.pending.values()) {
          request.reject(new Error("codex app-server exited before responding."));
        }
        this.pending = new Map();
      });

      let stdout = "";
      const pumpStdout = (chunk: Buffer | string) => {
        stdout += chunk.toString("utf8");
        let newlineIndex = stdout.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = stdout.slice(0, newlineIndex).trim();
          stdout = stdout.slice(newlineIndex + 1);
          this.handleLine(line);
          newlineIndex = stdout.indexOf("\n");
        }
      };

      child.stdout?.on("data", pumpStdout);
      child.stderr?.on("data", (chunk: Buffer | string) => {
        this.stderrTail.push(chunk.toString("utf8"));
        if (this.stderrTail.length > 20) this.stderrTail.shift();
      });

      // The handshake resolves readiness; errors before it complete reject startup.
      this.request("initialize", {
        clientInfo: { name: "synara-session-sync", title: "Synara Session Sync", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      })
        .then(() => {
          this.notify("initialized");
          resolve();
        })
        .catch(reject);
    });
  }

  private handleLine(line: string): void {
    if (line.length === 0) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (typeof message.id === "number" && this.pending.has(message.id)) {
      const pendingRequest = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (!pendingRequest) return;
      if (message.error) {
        pendingRequest.reject(new Error(message.error.message ?? "codex app-server error"));
      } else {
        pendingRequest.resolve(message.result);
      }
      return;
    }
  }

  private notify(method: string, params?: unknown): void {
    this.child?.stdin?.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) })}\n`,
    );
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = this.child;
      if (!child || child.exitCode !== null || !child.stdin?.writable) {
        rejectPromise(new Error("codex app-server is not running."));
        return;
      }
      const id = this.nextRequestId++;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`codex app-server request '${method}' timed out.`));
      }, 30_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolvePromise(value);
        },
        reject: (cause) => {
          clearTimeout(timeout);
          rejectPromise(cause);
        },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`,
      );
    });
  }

  /** One full page-set of threads. Throws when the child cannot serve; callers back off. */
  async listAllThreads(): Promise<CodexThreadRow[]> {
    await this.ensureRunning();
    const rows: CodexThreadRow[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 50; page += 1) {
      const result = (await this.request("thread/list", cursor ? { cursor } : {})) as
        | { data?: unknown; nextCursor?: unknown }
        | undefined;
      const data = Array.isArray(result?.data) ? result?.data : [];
      for (const raw of data) {
        const mapped = mapCodexThreadRow(raw);
        if (mapped) rows.push(mapped);
      }
      cursor = typeof result?.nextCursor === "string" ? result.nextCursor : null;
      if (!cursor) break;
    }
    return rows;
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
  }

  recentServerErrors(): string {
    return this.stderrTail.join("").trim();
  }
}
