// FILE: claudeCode.ts
// Purpose: Discovers Claude Code sessions from ~/.claude/projects transcript files.
// Layer: Session-sync provider discovery

import { readdirSync, statSync } from "node:fs";
import { createReadStream } from "node:fs";
import { basename, join } from "node:path";

import { createInterface } from "node:readline";

import type { DiscoveredSession } from "../types.ts";

interface ParsedSessionFile {
  readonly externalId: string;
  readonly cwd: string | null;
  readonly title: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** User prompts that are harness plumbing rather than human intent. */
function isImportableUserText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith("<")) return false;
  if (trimmed.startsWith("Caveat:")) return false;
  return true;
}

function textFromContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
        return part.text;
      }
    }
  }
  return null;
}

export function parseSessionLine(line: string, current: ParsedSessionFile): ParsedSessionFile {
  if (current.cwd !== null && current.title !== null) return current;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return current;
  }
  if (!isRecord(parsed)) return current;

  let { cwd, title } = current;

  if (cwd === null && typeof parsed["cwd"] === "string" && parsed["cwd"].length > 0) {
    cwd = parsed["cwd"];
  }

  if (title === null) {
    // Summary rows are written by Claude Code as compact thread titles.
    if (
      parsed["type"] === "summary" &&
      typeof parsed["summary"] === "string" &&
      parsed["summary"].trim().length > 0
    ) {
      title = parsed["summary"].trim();
    } else if (
      parsed["type"] === "user" &&
      parsed["isMeta"] !== true &&
      parsed["isSidechain"] !== true &&
      isRecord(parsed["message"])
    ) {
      const text = textFromContent(parsed["message"]["content"]);
      if (text !== null && isImportableUserText(text)) {
        title = text.trim();
      }
    }
  }

  return { ...current, cwd, title };
}

/**
 * Streams just enough of the transcript to learn where the session ran and
 * what it was about. Early-exits once both facts are known so huge sessions
 * cost milliseconds.
 */
export async function parseSessionFile(filePath: string): Promise<ParsedSessionFile> {
  const externalId = basename(filePath).replace(/\.jsonl$/i, "");
  let current: ParsedSessionFile = { externalId, cwd: null, title: null };

  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      current = parseSessionLine(line, current);
      if (current.cwd !== null && current.title !== null) break;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return current;
}

function listJsonlFiles(root: string, depthLimit: number): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < depthLimit) walk(entryPath, depth + 1);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(entryPath);
    }
  };
  walk(root, 0);
  return found;
}

export interface ScanClaudeSessionsResult {
  readonly sessions: DiscoveredSession[];
  /** Files that exist but could not be attributed to a working directory. */
  readonly skippedMissingCwd: number;
}

export async function scanClaudeSessions(root: string): Promise<ScanClaudeSessionsResult> {
  const files = listJsonlFiles(root, 4);
  const sessions: DiscoveredSession[] = [];
  let skippedMissingCwd = 0;

  for (const filePath of files) {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(filePath).mtimeMs;
    } catch {
      continue;
    }

    const parsed = await parseSessionFile(filePath);
    // Transcripts without a usable working directory cannot be placed under a
    // Synara project; count them instead of guessing an encoded directory name
    // (dashes in path segments make the directory name lossy).
    if (!parsed.cwd) {
      skippedMissingCwd += 1;
      continue;
    }

    sessions.push({
      provider: "claudeAgent",
      externalId: parsed.externalId,
      cwd: parsed.cwd,
      title: parsed.title,
      updatedAtMs: mtimeMs,
    });
  }

  return { sessions, skippedMissingCwd };
}
