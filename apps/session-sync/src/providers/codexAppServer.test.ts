// FILE: codexAppServer.test.ts
// Purpose: Verifies tolerant mapping of codex app-server thread rows.
// Layer: Session-sync discovery tests

import { describe, expect, it } from "vitest";

import { mapCodexThreadRow } from "./codexAppServer.ts";

describe("mapCodexThreadRow", () => {
  it("maps a full row with millisecond timestamps", () => {
    expect(
      mapCodexThreadRow({
        id: "019e0f40-85b6-7f30-abb4-2c35648f9239",
        cwd: "/home/robert/Projects/synara",
        title: "Fix rollout watcher",
        updatedAtMs: 1_787_000_000_000,
      }),
    ).toEqual({
      id: "019e0f40-85b6-7f30-abb4-2c35648f9239",
      cwd: "/home/robert/Projects/synara",
      title: "Fix rollout watcher",
      updatedAtMs: 1_787_000_000_000,
    });
  });

  it("normalizes second-granularity timestamps and derives titles from first user text", () => {
    expect(
      mapCodexThreadRow({
        id: "abc",
        cwd: "/tmp/x",
        firstUserMessage: [{ type: "text", text: "please help" }],
        updated_at_ms: 1_787_000_000,
      }),
    ).toEqual({
      id: "abc",
      cwd: "/tmp/x",
      title: "please help",
      updatedAtMs: 1_787_000_000_000,
    });
  });

  it("keeps rows without a working directory so the caller can skip them", () => {
    expect(mapCodexThreadRow({ id: "abc" })).toEqual({
      id: "abc",
      cwd: null,
      title: null,
      updatedAtMs: null,
    });
  });

  it("rejects malformed rows", () => {
    expect(mapCodexThreadRow(null)).toBeNull();
    expect(mapCodexThreadRow({})).toBeNull();
    expect(mapCodexThreadRow({ id: "" })).toBeNull();
    expect(mapCodexThreadRow("thread")).toBeNull();
  });
});
