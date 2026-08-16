import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import type { ComputerWindow } from "@synara/contracts";

import { AtspiHelperClient } from "./atspiClient.ts";

class FakeHelperProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn();
  killed = false;
}

const WINDOW: ComputerWindow = {
  id: "window-1",
  title: "Terminal",
  bounds: { x: 0, y: 0, width: 640, height: 480 },
  focused: true,
  minimized: false,
  visible: true,
};

describe("AtspiHelperClient", () => {
  it("starts the first helper request without the reconnect backoff", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeHelperProcess();
      child.stdin.on("data", (chunk) => {
        const message = JSON.parse(chunk.toString()) as { id: number | string };
        child.stdout.write(
          JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { trees: [] } }) + "\n",
        );
      });
      let spawned = false;
      const client = new AtspiHelperClient({
        spawnProcess: () => {
          spawned = true;
          return child as unknown as ChildProcessWithoutNullStreams;
        },
      });
      const request = client.readTrees([WINDOW]);

      await vi.runAllTicks();
      expect(spawned).toBe(true);
      await vi.runAllTicks();
      await expect(request).resolves.toEqual([]);
      await client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
