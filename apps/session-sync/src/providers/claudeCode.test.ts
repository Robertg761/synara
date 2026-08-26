// FILE: claudeCode.test.ts
// Purpose: Verifies Claude transcript parsing and session discovery behavior.
// Layer: Session-sync discovery tests

import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { parseSessionFile, parseSessionLine, scanClaudeSessions } from "./claudeCode.ts";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "session-sync-claude-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

it("extracts cwd and summary title without reading further than needed", () => {
  let parsed = { externalId: "s1", cwd: null as string | null, title: null as string | null };
  parsed = parseSessionLine(
    JSON.stringify({ type: "summary", summary: "Fix the widget", leafUuid: "x" }),
    parsed,
  );
  expect(parsed.title).toBe("Fix the widget");
  parsed = parseSessionLine(
    JSON.stringify({ type: "user", cwd: "/home/robert/Projects/synara" }),
    parsed,
  );
  expect(parsed.cwd).toBe("/home/robert/Projects/synara");
});

it("prefers real user prompts and skips meta/command plumbing", () => {
  let parsed = { externalId: "s2", cwd: null as string | null, title: null as string | null };
  parsed = parseSessionLine(
    JSON.stringify({
      type: "user",
      isMeta: true,
      message: { role: "user", content: "system injected" },
    }),
    parsed,
  );
  parsed = parseSessionLine(
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "<command-name>/clear</command-name>" },
    }),
    parsed,
  );
  parsed = parseSessionLine(
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Ship the sync daemon" }] },
    }),
    parsed,
  );
  expect(parsed.title).toBe("Ship the sync daemon");
});

it("falls back to later lines when early ones carry nothing useful", async () => {
  const root = makeTempRoot();
  const projectDir = join(root, "-home-robert-Projects-demo");
  mkdirSync(projectDir);
  const filePath = join(projectDir, "abc123.jsonl");
  writeFileSync(
    filePath,
    [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
      JSON.stringify({ type: "user", cwd: "/tmp/demo" }),
      JSON.stringify({ type: "user", message: { role: "user", content: "Do a thing" } }),
    ].join("\n"),
    "utf8",
  );

  const parsed = await parseSessionFile(filePath);
  expect(parsed.externalId).toBe("abc123");
  expect(parsed.cwd).toBe("/tmp/demo");
  expect(parsed.title).toBe("Do a thing");
});

it("scans nested transcripts and reports sessions missing a working directory", async () => {
  const root = makeTempRoot();
  mkdirSync(join(root, "proj-a"), { recursive: true });
  mkdirSync(join(root, "nested", "proj-b"), { recursive: true });

  writeFileSync(
    join(root, "proj-a", "one.jsonl"),
    `${JSON.stringify({ type: "user", cwd: "/repo/a", message: { content: "First" } })}\n`,
    "utf8",
  );
  writeFileSync(join(root, "nested", "proj-b", "two.jsonl"), "{}\n", "utf8");

  const result = await scanClaudeSessions(root);
  expect(result.sessions).toHaveLength(1);
  expect(result.sessions[0]).toMatchObject({
    provider: "claudeAgent",
    externalId: "one",
    cwd: "/repo/a",
    title: "First",
  });
  expect(result.skippedMissingCwd).toBe(1);
});

it("surfaces file mtimes so quiet-period deferral works", async () => {
  const root = makeTempRoot();
  mkdirSync(join(root, "p"), { recursive: true });
  const filePath = join(root, "p", "fresh.jsonl");
  writeFileSync(filePath, `${JSON.stringify({ type: "user", cwd: "/repo/fresh" })}\n`, "utf8");
  const old = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(filePath, old, old);

  const result = await scanClaudeSessions(root);
  expect(result.sessions).toHaveLength(1);
  expect(result.sessions[0]!.updatedAtMs).toBeLessThan(Date.now() - 30 * 60 * 1000);
});
