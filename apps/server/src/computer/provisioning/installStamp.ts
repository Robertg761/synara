/**
 * What was installed, and whether this build still agrees with it.
 *
 * The desktop helper has no version handshake — it speaks a wire protocol whose
 * version is a constant in `desktopHelperClient.ts`, not something the binary
 * reports — so nothing about a binary sitting at the install path says which
 * Synara built it. Without that, `resolveDesktopHelper` accepts whatever is
 * there forever, and a user who updates Synara keeps running the helper they
 * compiled against last release's sources.
 *
 * So an install writes a stamp beside the binary naming the fingerprint it was
 * built from, and provisioning treats a mismatch as "not installed". The
 * fingerprint is a hash of the helper's own sources rather than the app version:
 * most Synara releases do not touch `native/computer-desktop-helper`, and
 * recompiling on every release would spend a user's CPU to produce a
 * byte-identical binary.
 *
 * Deliberately not the KWin plugin's stamp format. That one records a plugin id
 * and the KWin it was built against because KWin pins a loaded library and each
 * install needs its own version suffix; the helper is an ordinary executable
 * that is replaced by an atomic rename, so the only question it has to answer is
 * "is this current".
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Sits beside the binary so removing the install directory removes both. */
export const INSTALL_STAMP_SUFFIX = ".stamp.json";

export interface InstallStamp {
  /** Hash of the sources the installed binary was produced from. */
  readonly fingerprint: string;
  /** How it got there, for the settings card and for support questions. */
  readonly source: string;
  readonly installedAt: string;
}

export function installStampPath(binaryPath: string): string {
  return `${binaryPath}${INSTALL_STAMP_SUFFIX}`;
}

/** The stamp, or `undefined` when there is none or it cannot be believed. */
export async function readInstallStamp(path: string): Promise<InstallStamp | undefined> {
  const raw = await readFile(path, "utf8").catch(() => undefined);
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A truncated or hand-edited stamp is not a reason to refuse to provision;
    // it is a reason to provision again, which is what "no stamp" already means.
    return undefined;
  }
  const record = parsed as Partial<InstallStamp> | null;
  if (!record || typeof record !== "object") return undefined;
  const { fingerprint, source, installedAt } = record;
  if (typeof fingerprint !== "string" || fingerprint.trim() === "") return undefined;
  return {
    fingerprint,
    source: typeof source === "string" ? source : "unknown",
    installedAt: typeof installedAt === "string" ? installedAt : "",
  };
}

export async function writeInstallStamp(path: string, stamp: InstallStamp): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(stamp, null, 2)}\n`);
}

/**
 * A stable hash of a source tree, as the thing an install is keyed on.
 *
 * Reads file contents rather than mtimes: a checkout, a `git clean`, and an
 * unpacked release all produce different timestamps for identical sources, and
 * keying on those would recompile the helper for no reason on every fresh
 * clone. Names go into the hash alongside contents so that moving a file is a
 * change even when the bytes are not.
 *
 * Returns `undefined` when the tree cannot be read at all, which callers treat
 * as "cannot tell" rather than "changed" — a build that has no sources shipped
 * has nothing to compare against and must not thrash the install.
 */
export async function fingerprintSourceTree(root: string): Promise<string | undefined> {
  const files = await collectFiles(root, root).catch(() => undefined);
  if (!files || files.length === 0) return undefined;
  const hash = createHash("sha256");
  // Sorted so the hash is a property of the tree, not of directory iteration
  // order, which differs between filesystems.
  for (const entry of files.toSorted((a, b) => (a.relative < b.relative ? -1 : 1))) {
    hash.update(entry.relative);
    hash.update("\0");
    hash.update(entry.bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

interface SourceFile {
  readonly relative: string;
  readonly bytes: Buffer;
}

/**
 * `prebuilt/` is skipped: it holds binaries shipped for other distributions,
 * which have nothing to do with what a local build would produce, and hashing
 * them would invalidate every install whenever the release matrix changed.
 */
const IGNORED_DIRECTORIES = new Set(["prebuilt", ".git", "node_modules"]);

async function collectFiles(root: string, directory: string): Promise<readonly SourceFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const collected: SourceFile[] = [];
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      collected.push(...(await collectFiles(root, full)));
      continue;
    }
    if (!entry.isFile()) continue;
    // Guards against a stray build artifact making the fingerprint enormous;
    // every real source file here is a few kilobytes of C or XML.
    const info = await stat(full).catch(() => undefined);
    if (!info || info.size > MAX_SOURCE_FILE_BYTES) continue;
    const bytes = await readFile(full).catch(() => undefined);
    if (!bytes) continue;
    collected.push({ relative: full.slice(root.length + 1), bytes });
  }
  return collected;
}

const MAX_SOURCE_FILE_BYTES = 4 * 1024 * 1024;
