import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { MacComputerHelperClient, MacComputerHelperError } from "./macComputerHelperClient.ts";

/**
 * A fake child process wired to real streams, so the client exercises the actual
 * JSON-RPC framing rather than a mock of it. `respond` maps a method to the
 * result the fake helper answers with; an unmapped method returns `{ok:true}`.
 */
class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  constructor(private readonly respond: (method: string) => unknown) {
    super();
    let buffer = "";
    this.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        this.handle(line);
        newline = buffer.indexOf("\n");
      }
    });
  }

  private handle(line: string): void {
    const message = JSON.parse(line) as { id: number; method: string };
    const result = this.respond(message.method);
    // `undefined` means "do not reply", so a test can leave a request hanging.
    if (result === undefined) return;
    const response = `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`;
    setImmediate(() => this.stdout.write(response));
  }

  kill(): void {
    this.killed = true;
    this.emit("exit", 0, null);
  }
}

function clientWith(respond: (method: string) => unknown): {
  client: MacComputerHelperClient;
  child: FakeChild;
} {
  const child = new FakeChild(respond);
  const client = new MacComputerHelperClient({
    binaryPath: "/fake/computer-helper",
    // The client only touches stdin/stdout/stderr/on/kill, which the fake has.
    spawn: () => child as unknown as ChildProcessWithoutNullStreams,
  });
  return { client, child };
}

describe("MacComputerHelperClient", () => {
  it("correlates a request with its response", async () => {
    const { client } = clientWith((method) =>
      method === "capabilities" ? { screenRecording: true } : { ok: true },
    );
    const result = await client.request("capabilities");
    expect(result).toEqual({ screenRecording: true });
    await client.dispose();
  });

  it("emits the ready notification without treating it as a response", async () => {
    const { client, child } = clientWith(() => ({ ok: true }));
    child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "ready", params: {} })}\n`);
    // A notification must not settle any request; a following request still works.
    const result = await client.request("ping");
    expect(result).toEqual({ ok: true });
    await client.dispose();
  });

  it("rejects an in-flight request with helper_exited when the process dies", async () => {
    // Returning undefined makes the fake leave the request unanswered, so the
    // exit path is what settles it.
    const { client, child } = clientWith(() => undefined);
    const pending = client.request("list-windows");
    setImmediate(() => child.emit("exit", 1, null));
    const error = await pending.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(MacComputerHelperError);
    expect((error as MacComputerHelperError).code).toBe("helper_exited");
  });
});
