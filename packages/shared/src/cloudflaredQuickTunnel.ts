// FILE: cloudflaredQuickTunnel.ts
// Purpose: Managed `cloudflared` quick tunnels — the zero-account "connect from
//          anywhere" path. A quick tunnel gives the local server a public HTTPS
//          URL relayed through Cloudflare's edge; no port forwarding, no signup.
// Layer: Shared runtime (desktop main process and the headless server CLI)

import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";

export type QuickTunnelState = "starting" | "connected" | "stopped" | "error";

export interface QuickTunnelHandle {
  readonly state: () => QuickTunnelState;
  readonly url: () => string | null;
  /** Human-readable detail for the last failure, when state is "error". */
  readonly detail: () => string | null;
  /**
   * Resolves with the public URL once Cloudflare reports the tunnel, or `null`
   * when the tunnel failed or was stopped inside [timeoutMs].
   */
  readonly waitForUrl: (timeoutMs?: number) => Promise<string | null>;
  readonly stop: () => Promise<void>;
}

/** Command line that starts a quick tunnel forwarding [targetUrl] to the edge. */
export function buildCloudflaredArgs(targetUrl: string): Array<string> {
  return ["tunnel", "--url", targetUrl, "--no-autoupdate", "--protocol", "http2"];
}

/**
 * Extracts the quick-tunnel URL from cloudflared's output.
 *
 * The banner is human-facing text on stderr, so matching the bare hostname keeps
 * this resilient to copy changes around it.
 */
export function parseTryCloudflareUrl(text: string): string | null {
  // The trailing lookahead keeps a hostile suffix like
  // `a.trycloudflare.com.evil.test` from matching as a tunnel host.
  const match = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com(?![\w.-])/i.exec(text);
  return match ? match[0] : null;
}

/** Finds a usable cloudflared binary, or `null` when none is installed. */
export function resolveCloudflaredCommand(explicit?: string): string | null {
  if (explicit) return explicit;
  const path = process.env.PATH ?? "";
  for (const dir of path.split(delimiter())) {
    if (!dir) continue;
    const candidate = `${dir}/${executableName()}`;
    if (isExecutableFile(candidate)) return candidate;
  }
  for (const candidate of commonLocations()) {
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

const RESTART_DELAYS_MS = [1_000, 3_000, 8_000];

/**
 * Starts a quick tunnel and keeps it alive.
 *
 * cloudflared owns the outbound connection, so nothing here touches the server's
 * bind address or auth policy: the tunnel dials the loopback target from this
 * machine, and Cloudflare terminates the public TLS side. Unexpected exits are
 * retried with a short backoff — quick tunnels are ephemeral by design, and a
 * new one is as good as the old one — until the retries run out and the handle
 * reports "error" for the UI to explain.
 */
export function startQuickTunnel(input: {
  readonly targetUrl: string;
  readonly command?: string;
  readonly log?: (line: string) => void;
}): QuickTunnelHandle {
  const command = resolveCloudflaredCommand(input.command);
  const log = input.log ?? (() => {});
  if (!command) {
    return failedHandle("cloudflared is not installed.");
  }

  let state: QuickTunnelState = "starting";
  let url: string | null = null;
  let detail: string | null = null;
  let stopping = false;
  let attempt = 0;
  let child: ChildProcess | null = null;
  const urlWaiters: Array<(url: string | null) => void> = [];

  const setState = (next: QuickTunnelState, nextDetail?: string | null) => {
    state = next;
    detail = nextDetail ?? null;
  };

  const resolveWaiters = () => {
    if (url == null) return;
    while (urlWaiters.length > 0) urlWaiters.splice(0).pop()?.(url);
  };

  const spawnAttempt = () => {
    if (stopping) return;
    log(`starting cloudflared (attempt ${attempt + 1})`);
    // Quick-tunnel banners land on stderr; stdout carries operational logs. Both
    // are scanned so a future cloudflared that moves the banner still works.
    child = spawn(command, buildCloudflaredArgs(input.targetUrl), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const scan = (chunk: Buffer | string) => {
      const text = String(chunk);
      log(text.trimEnd());
      const found = parseTryCloudflareUrl(text);
      if (found && found !== url) {
        url = found;
        setState("connected");
        resolveWaiters();
      }
    };
    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan);
    child.on("exit", (code, signal) => {
      child = null;
      if (stopping) {
        setState("stopped");
        return;
      }
      if (url != null && attempt >= RESTART_DELAYS_MS.length) {
        setState(
          "error",
          `cloudflared exited (code=${code ?? "null"} signal=${signal ?? "null"}).`,
        );
        return;
      }
      const delay = RESTART_DELAYS_MS[Math.min(attempt, RESTART_DELAYS_MS.length - 1)] ?? 1_000;
      attempt += 1;
      setState("starting", `cloudflared exited; retrying in ${delay / 1000}s`);
      setTimeout(spawnAttempt, delay).unref();
    });
    child.on("error", (error) => {
      if (!stopping) setState("error", error.message);
    });
  };

  spawnAttempt();

  return {
    state: () => state,
    url: () => url,
    detail: () => detail,
    waitForUrl: (timeoutMs = 45_000) =>
      new Promise((resolve) => {
        if (url != null) {
          resolve(url);
          return;
        }
        if (state === "error" || state === "stopped") {
          resolve(null);
          return;
        }
        let settled = false;
        const waiter = (value: string | null) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        urlWaiters.push(waiter);
        setTimeout(() => {
          if (settled) return;
          settled = true;
          const index = urlWaiters.indexOf(waiter);
          if (index >= 0) urlWaiters.splice(index, 1);
          resolve(url);
        }, timeoutMs).unref();
      }),
    stop: () =>
      new Promise((resolve) => {
        stopping = true;
        const current = child;
        if (current == null) {
          setState("stopped");
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          current.kill("SIGKILL");
          resolve();
        }, 3_000);
        current.once("exit", () => {
          clearTimeout(timer);
          setState("stopped");
          resolve();
        });
        current.kill("SIGTERM");
      }),
  };
}

function failedHandle(reason: string): QuickTunnelHandle {
  return {
    state: () => "error",
    url: () => null,
    detail: () => reason,
    waitForUrl: () => Promise.resolve(null),
    stop: () => Promise.resolve(),
  };
}

function executableName(): string {
  return process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
}

function delimiter(): string {
  return process.platform === "win32" ? ";" : ":";
}

function commonLocations(): Array<string> {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    return localAppData ? [`${localAppData}\\Microsoft\\WinGet\\Links\\cloudflared.exe`] : [];
  }
  return [
    "/usr/bin/cloudflared",
    "/usr/local/bin/cloudflared",
    "/opt/homebrew/bin/cloudflared",
    `${process.env.HOME ?? ""}/.local/bin/cloudflared`,
  ];
}

function isExecutableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
