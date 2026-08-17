/**
 * A supervised child process whose failures explain themselves.
 *
 * Every helper this feature boots — the nested compositor and its private bus
 * today, the wlroots/PipeWire desktop helper next — fails in the same three
 * ways: it never starts, it exits early, or it starts and then says nothing.
 * All three are only diagnosable from the process's own stderr, and none of
 * them should be waited out to a deadline when the process is already gone. So
 * a spawn error or an early exit is recorded rather than thrown, every wait
 * watches for it, and the stderr tail rides along on the failure message.
 */
import { spawn, type ChildProcess } from "node:child_process";

import { ComputerBackendError } from "./ComputerBackend.ts";

/** Enough child stderr to quote a startup failure, never a whole log. */
const MAX_DIAGNOSTIC_BYTES = 4 * 1024;
const TERMINATE_GRACE_MS = 2_000;

/**
 * One supervised child. A spawn error or an early exit is recorded instead of
 * thrown, so every wait can fail fast with the process's own diagnostic rather
 * than running to its deadline.
 */
export class SupervisedProcess {
  private readonly stderr: Buffer[] = [];
  private stderrBytes = 0;
  private exited: string | undefined;
  private readonly finished: Promise<void>;

  constructor(
    private readonly command: string,
    private readonly child: ChildProcess,
  ) {
    child.stderr?.on("data", (chunk: Buffer) => this.pushStderr(chunk));
    child.on("error", (error) => {
      this.exited ??= describeProcessError(error);
    });
    this.finished = new Promise<void>((resolve) => {
      child.on("exit", (code, signal) => {
        this.exited ??= `exit code ${code ?? "null"}, signal ${signal ?? "null"}`;
        resolve();
      });
      child.on("error", () => resolve());
    });
    // The process handle must not hold the server's event loop open. The stdio
    // pipes stay referenced until terminate destroys them, because the startup
    // handshake reads them and an unreferenced pipe can lose that race.
    child.unref();
  }

  /** A daemon that prints its address and then serves; only the first line matters. */
  readFirstStdoutLine(timeoutMs: number): Promise<string> {
    const stdout = this.child.stdout;
    if (!stdout) {
      return Promise.reject(new ComputerBackendError(`${this.command} has no stdout to read.`));
    }
    return new Promise<string>((resolve, reject) => {
      let buffered = "";
      const settle = (outcome: () => void) => {
        clearTimeout(timer);
        stdout.off("data", onData);
        this.child.off("exit", onExit);
        this.child.off("error", onExit);
        outcome();
      };
      const onData = (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        const newline = buffered.indexOf("\n");
        if (newline >= 0) settle(() => resolve(buffered.slice(0, newline).trim()));
      };
      const onExit = () => {
        settle(() =>
          reject(
            new ComputerBackendError(
              `${this.command} exited before it printed anything: ${this.exitDiagnostic() ?? "unknown reason"}.${this.diagnostic()}`,
            ),
          ),
        );
      };
      const timer = setTimeout(() => {
        settle(() =>
          reject(
            new ComputerBackendError(
              `${this.command} printed no output within ${timeoutMs} ms.${this.diagnostic()}`,
            ),
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      stdout.on("data", onData);
      this.child.once("exit", onExit);
      this.child.once("error", onExit);
    });
  }

  /** How the process ended, or `undefined` while it is still running. */
  exitDiagnostic(): string | undefined {
    return this.exited;
  }

  /** The tail of stderr, formatted for appending to a failure message. */
  diagnostic(): string {
    const text = Buffer.concat(this.stderr).toString("utf8").trim();
    return text.length > 0 ? ` Last ${this.command} output: ${text}` : "";
  }

  /** Ends the process, escalating to SIGKILL, and releases its pipes. */
  async terminate(): Promise<void> {
    if (this.exited === undefined && !this.child.killed) {
      this.child.kill("SIGTERM");
      const escalation = setTimeout(() => this.child.kill("SIGKILL"), TERMINATE_GRACE_MS);
      escalation.unref?.();
      await this.finished;
      clearTimeout(escalation);
    }
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
  }

  private pushStderr(chunk: Buffer): void {
    this.stderr.push(chunk);
    this.stderrBytes += chunk.byteLength;
    while (this.stderrBytes > MAX_DIAGNOSTIC_BYTES && this.stderr.length > 1) {
      this.stderrBytes -= this.stderr.shift()?.byteLength ?? 0;
    }
  }
}

export type SupervisedSpawn = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => ChildProcess;

/**
 * The default spawn for a supervised child: an ordinary child of this process,
 * so a signal to the server's process group reaches it too, with stderr piped
 * because the diagnostic is the whole point.
 */
export const spawnSupervisedProcess: SupervisedSpawn = (command, args, env) =>
  spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], env });

/**
 * Spawns and wraps a child, converting a spawn failure into the same error type
 * every later failure uses so a caller has one thing to catch.
 */
export function startSupervisedProcess(options: {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly spawnProcess?: SupervisedSpawn;
}): SupervisedProcess {
  const spawnProcess = options.spawnProcess ?? spawnSupervisedProcess;
  let child: ChildProcess;
  try {
    child = spawnProcess(options.command, options.args, options.env);
  } catch (error) {
    throw new ComputerBackendError(
      `${options.command} could not be started: ${describeProcessError(error)}`,
      { cause: error },
    );
  }
  return new SupervisedProcess(options.command, child);
}

export function describeProcessError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
