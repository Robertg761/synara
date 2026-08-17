/**
 * The transport's own tests stand in for the C helper.
 *
 * The helper is the other implementer of this wire, so the fake child here
 * frames its answers exactly the way the C side does: JSON-RPC lines on stdout,
 * length-prefixed frame envelopes on fd 3. What that buys is coverage of the
 * two orderings between those channels, which no fake at the provider level can
 * reach and which the live compositor lane cannot reliably provoke.
 */
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { encodeFrameEnvelope } from "@synara/shared/frameTransport";
import { encodeLengthPrefixedRecord } from "@synara/shared/lengthPrefixedRecords";
import { describe, expect, it, vi } from "vitest";

import {
  DESKTOP_HELPER_FRAME_CODEC,
  DesktopHelperClient,
  readWaylandGlobals,
  shareDesktopHelper,
} from "./desktopHelperClient.ts";

type Params = Record<string, unknown>;

/**
 * The helper's four pipes. `stdio` carries them because that is what
 * `SupervisedProcess.extraStream(3)` reads, and `kill` reports an exit because
 * `terminate()` waits for one.
 */
class FakeHelperProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly frameChannel = new PassThrough();
  readonly stdio = [this.stdin, this.stdout, this.stderr, this.frameChannel];
  killed = false;
  readonly kill = vi.fn((_signal?: NodeJS.Signals) => {
    if (this.killed) return true;
    this.killed = true;
    this.emit("exit", 0, "SIGTERM");
    return true;
  });
  readonly unref = vi.fn();

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }

  /** Answers requests the way the helper does: one JSONL response per line in. */
  respond(
    handler: (request: { readonly method: string; readonly params: Params }) => unknown,
  ): this {
    this.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim().length === 0) continue;
        const request = JSON.parse(line) as { id: number | string; method: string; params: Params };
        const answer = handler({ method: request.method, params: request.params ?? {} });
        this.stdout.write(
          `${JSON.stringify(
            answer instanceof Error
              ? {
                  jsonrpc: "2.0",
                  id: request.id,
                  error: {
                    code: answer instanceof HelperRefusal ? answer.code : -32000,
                    message: answer.message,
                  },
                }
              : { jsonrpc: "2.0", id: request.id, result: answer },
          )}\n`,
        );
      }
    });
    return this;
  }

  /** One capture payload on fd 3, framed exactly as the helper frames it. */
  writeFrame(streamId: string, payload: Uint8Array, sequence = 1): void {
    this.frameChannel.write(
      encodeLengthPrefixedRecord(
        encodeFrameEnvelope(DESKTOP_HELPER_FRAME_CODEC, {
          header: { streamId, sequence, timestampMs: 0, keyframe: true, codecConfig: false },
          payload,
        }),
      ),
    );
  }
}

/**
 * A refusal carrying the code the C helper would send. A plain `Error` is the
 * -32000 default, which keeps every test that predates the codes reading the
 * way it did.
 */
class HelperRefusal extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

const HELPER_PATH = "/tmp/synara-computer-desktop-helper";
const REGION = { x: 0, y: 0, width: 800, height: 600 };
const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3);

function clientFor(child: FakeHelperProcess, onSpawn?: () => void): DesktopHelperClient {
  return new DesktopHelperClient({
    command: HELPER_PATH,
    spawnProcess: () => {
      onSpawn?.();
      return child.asChildProcess();
    },
  });
}

const bytes = (value: Uint8Array): readonly number[] => Array.from(value);

describe("DesktopHelperClient", () => {
  it("reads the desktop geometry off the control channel", async () => {
    const child = new FakeHelperProcess().respond(() => ({
      outputs: [{ name: "DP-1", x: 0, y: 0, width: 2560, height: 1440, scale: 1.5 }],
      workspace: { x: 0, y: 0, width: 2560, height: 1440 },
    }));
    const client = clientFor(child);

    await expect(client.outputs()).resolves.toEqual({
      outputs: [{ name: "DP-1", rect: { x: 0, y: 0, width: 2560, height: 1440 }, scale: 1.5 }],
      workspace: { x: 0, y: 0, width: 2560, height: 1440 },
    });

    await client.dispose();
  });

  it("refuses geometry with no workspace rather than inventing a coordinate space", async () => {
    const child = new FakeHelperProcess().respond(() => ({ outputs: [] }));
    const client = clientFor(child);

    await expect(client.outputs()).rejects.toThrow(/no workspace rect/);

    await client.dispose();
  });

  it("matches a capture payload that arrives after its response", async () => {
    // stdout and fd 3 are separate pipes with no ordering guarantee, so the
    // response winning the race must not lose the image.
    const child = new FakeHelperProcess().respond(({ method }) => {
      if (method !== "capture") return {};
      setTimeout(() => child.writeFrame("capture-1", PNG), 5);
      return { streamId: "capture-1", region: REGION };
    });
    const client = clientFor(child);

    const capture = await client.capture({ region: REGION, maxDimension: 2048 });
    expect(bytes(capture.bytes)).toEqual(bytes(PNG));
    expect(capture.region).toEqual(REGION);

    await client.dispose();
  });

  it("matches a capture payload that arrived before its response", async () => {
    const child = new FakeHelperProcess().respond(({ method }) => {
      if (method !== "capture") return {};
      // The usual order: the helper writes the frame, then answers.
      child.writeFrame("capture-7", PNG, 7);
      return { streamId: "capture-7", region: REGION };
    });
    const client = clientFor(child);

    const capture = await client.capture({ region: REGION, maxDimension: 1024 });
    expect(bytes(capture.bytes)).toEqual(bytes(PNG));

    await client.dispose();
  });

  it("reports the region the helper covered, not the one that was asked for", async () => {
    // A request past the edge of the outputs comes back clipped, and the caller
    // scales its coordinates against what the pixels actually cover.
    const covered = { x: 0, y: 0, width: 1920, height: 1080 };
    const child = new FakeHelperProcess().respond(({ method, params }) => {
      if (method !== "capture") return {};
      expect(params).toMatchObject({ x: 0, y: 0, width: 4000, height: 3000, maxDimension: 900 });
      child.writeFrame("capture-2", PNG);
      return { streamId: "capture-2", region: covered };
    });
    const client = clientFor(child);

    const capture = await client.capture({
      region: { x: 0, y: 0, width: 4000, height: 3000 },
      maxDimension: 900,
    });
    expect(capture.region).toEqual(covered);

    await client.dispose();
  });

  it("refuses a capture answered without a stream id rather than inventing one", async () => {
    const child = new FakeHelperProcess().respond(() => ({ region: REGION }));
    const client = clientFor(child);

    await expect(client.capture({ region: REGION, maxDimension: 64 })).rejects.toThrow(
      /stream id and region/,
    );

    await client.dispose();
  });

  it("drops a window entry with no id rather than reporting one nobody can address", async () => {
    const child = new FakeHelperProcess().respond(() => ({
      windows: [
        { id: "toplevel-1", title: "Files", appId: "org.gnome.Nautilus", activated: true },
        { title: "no id here" },
      ],
    }));
    const client = clientFor(child);

    await expect(client.listWindows()).resolves.toEqual([
      {
        id: "toplevel-1",
        title: "Files",
        appId: "org.gnome.Nautilus",
        activated: true,
        minimized: false,
        maximized: false,
        fullscreen: false,
      },
    ]);

    await client.dispose();
  });

  it("refuses a window list with no windows array instead of answering nothing", async () => {
    // An empty desktop and a helper that answered the wrong shape are not the
    // same fact, and reporting the second as the first is the lie this feature
    // is not allowed to tell.
    const child = new FakeHelperProcess().respond(() => ({}));
    const client = clientFor(child);

    await expect(client.listWindows()).rejects.toThrow(/without a windows array/);

    await client.dispose();
  });

  it("reads the seat's idle state, echoing back the timeout it was armed at", async () => {
    // `idle: false` is the answer that makes the arbiter yield the seat, so the
    // flag has to survive the round trip exactly as the compositor gave it.
    const child = new FakeHelperProcess().respond(({ method, params }) => {
      expect(method).toBe("idleState");
      expect(params).toEqual({ timeoutMs: 500 });
      return { idle: false, sinceMs: 340, timeoutMs: 500, observed: true };
    });
    const client = clientFor(child);

    await expect(client.idleState(500)).resolves.toEqual({
      idle: false,
      sinceMs: 340,
      timeoutMs: 500,
      observed: true,
    });

    await client.dispose();
  });

  it("keeps 'the compositor has not spoken yet' distinct from 'the seat is busy'", async () => {
    // The two look identical on the wire — both are `idle: false` — and they
    // mean opposite things about whether the answer can be trusted at all.
    const child = new FakeHelperProcess().respond(() => ({
      idle: false,
      sinceMs: 12,
      timeoutMs: 500,
      observed: false,
    }));
    const client = clientFor(child);

    await expect(client.idleState(500)).resolves.toMatchObject({
      observed: false,
    });

    await client.dispose();
  });

  it("refuses an idle answer missing a field rather than guessing at the human", async () => {
    // Defaulting the elapsed time, the armed timeout, or whether the compositor
    // has said anything at all would hand the arbiter this module's guess
    // wearing the compositor's authority.
    const child = new FakeHelperProcess().respond(() => ({
      idle: true,
      sinceMs: 5,
      timeoutMs: 500,
    }));
    const client = clientFor(child);

    await expect(client.idleState(500)).rejects.toThrow(/whether the human is at the keyboard/);

    await client.dispose();
  });

  it("keeps the process when the helper refuses a method", async () => {
    // "This compositor has no foreign-toplevel protocol" is a correct answer
    // that a restart cannot change, so restarting on it would be a spawn loop.
    let spawns = 0;
    const child = new FakeHelperProcess().respond(({ method }) =>
      method === "listWindows"
        ? new HelperRefusal(
            "this compositor does not implement zwlr_foreign_toplevel_manager_v1",
            -32001,
          )
        : {},
    );
    const client = clientFor(child, () => (spawns += 1));

    // -32001 is permanent: retrying it is a busy loop against a compositor that
    // will keep giving the same answer.
    await expect(client.listWindows()).rejects.toMatchObject({
      message: expect.stringMatching(/zwlr_foreign_toplevel_manager_v1/) as unknown as string,
      retryable: false,
    });
    await expect(client.pointerMotion(10, 20)).resolves.toBeUndefined();
    expect(spawns).toBe(1);

    await client.dispose();
  });

  it("passes a transient refusal through as retryable, without a restart", async () => {
    // -32002 is the helper saying the request could work next time: an output
    // that vanished mid-capture, a compositor that timed out. The caller may
    // try again, but the process is not the problem and is left running.
    let spawns = 0;
    let refusals = 0;
    const child = new FakeHelperProcess().respond(({ method }) => {
      if (method !== "capture") return {};
      refusals += 1;
      return refusals === 1
        ? new HelperRefusal("an output was disconnected while it was being captured", -32002)
        : { streamId: "capture-2", sequence: 2, region: REGION };
    });
    const client = clientFor(child, () => (spawns += 1));

    await expect(client.capture({ region: REGION, maxDimension: 400 })).rejects.toMatchObject({
      retryable: true,
    });
    expect(spawns).toBe(1);

    const second = client.capture({ region: REGION, maxDimension: 400 });
    child.writeFrame("capture-2", PNG, 2);
    await expect(second.then((capture) => bytes(capture.bytes))).resolves.toEqual(bytes(PNG));
    expect(spawns).toBe(1);

    await client.dispose();
  });

  it("treats an unlabelled refusal as permanent, so an old helper cannot spin", async () => {
    // -32000 and a bare -32601 carry no retry advice; the safe reading is the
    // one that cannot loop.
    const child = new FakeHelperProcess().respond(
      () => new Error('"width" must be between 0 and 1000000'),
    );
    const client = clientFor(child);

    await expect(client.capture({ region: REGION, maxDimension: 400 })).rejects.toMatchObject({
      retryable: false,
    });

    await client.dispose();
  });

  it("fails a request the moment the helper dies, quoting its stderr", async () => {
    const child = new FakeHelperProcess();
    child.stdin.on("data", () => {
      child.stderr.write("wl_display@1: error 1: invalid arguments\n");
      setImmediate(() => child.emit("exit", 1, null));
    });
    const client = clientFor(child);

    await expect(client.outputs()).rejects.toThrow(/invalid arguments/);

    await client.dispose();
  });

  it("restarts on the next request, after backing off once", async () => {
    const dead = new FakeHelperProcess();
    dead.stdin.on("data", () => setImmediate(() => dead.emit("exit", 1, null)));
    const live = new FakeHelperProcess().respond(() => ({ windows: [] }));
    const children = [dead, live];
    let spawns = 0;
    const client = new DesktopHelperClient({
      command: HELPER_PATH,
      spawnProcess: () => (children[spawns++] ?? live).asChildProcess(),
    });

    await expect(client.listWindows()).rejects.toThrow(/exited/);
    // 250ms * 2^1 before the retry: a helper that just died of a compositor
    // shutting down must not be respawned in a hot loop.
    const startedAt = Date.now();
    await expect(client.listWindows()).resolves.toEqual([]);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(400);
    expect(spawns).toBe(2);

    await client.dispose();
  });

  it("never rejects releaseAll, because it runs on the disposal path", async () => {
    const child = new FakeHelperProcess().respond(() => new Error("the seat is gone"));
    const client = clientFor(child);

    await expect(client.pointerMotion(1, 1)).rejects.toThrow(/the seat is gone/);
    await expect(client.releaseAll()).resolves.toBeUndefined();

    await client.dispose();
  });

  it("refuses every request once disposed", async () => {
    const child = new FakeHelperProcess().respond(() => ({}));
    const client = clientFor(child);

    await client.pointerMotion(0, 0);
    await client.dispose();

    await expect(client.pointerMotion(0, 0)).rejects.toThrow(/disposed/);
  });
});

describe("shareDesktopHelper", () => {
  it("disposes once, after the last user has released", async () => {
    let disposals = 0;
    const releases = shareDesktopHelper(
      {
        dispose: () => {
          disposals += 1;
          return Promise.resolve();
        },
      },
      3,
    );

    await releases[0]?.();
    await releases[0]?.();
    expect(disposals).toBe(0);

    await releases[1]?.();
    await releases[2]?.();
    expect(disposals).toBe(1);
  });
});

describe("readWaylandGlobals", () => {
  it("reads the compositor's protocol list from a short-lived invocation", async () => {
    const child = new FakeHelperProcess();
    queueMicrotask(() =>
      child.stdout.write(
        `${JSON.stringify({
          globals: [
            { interface: "wl_seat", name: 1, version: 9 },
            { interface: "zwlr_virtual_pointer_manager_v1", name: 2, version: 2 },
          ],
        })}\n`,
      ),
    );

    await expect(
      readWaylandGlobals({ command: HELPER_PATH, spawnProcess: () => child.asChildProcess() }),
    ).resolves.toEqual(["wl_seat", "zwlr_virtual_pointer_manager_v1"]);
    expect(child.kill).toHaveBeenCalled();
  });

  it("rejects rather than reporting a compositor with no protocols", async () => {
    const child = new FakeHelperProcess();
    queueMicrotask(() => child.emit("exit", 1, null));

    await expect(
      readWaylandGlobals({ command: HELPER_PATH, spawnProcess: () => child.asChildProcess() }),
    ).rejects.toThrow(/exited before it printed anything/);
  });

  it("rejects when the helper prints something that is not a global list", async () => {
    const child = new FakeHelperProcess();
    queueMicrotask(() => child.stdout.write("not json\n"));

    await expect(
      readWaylandGlobals({ command: HELPER_PATH, spawnProcess: () => child.asChildProcess() }),
    ).rejects.toThrow(/no Wayland global list/);
  });
});
