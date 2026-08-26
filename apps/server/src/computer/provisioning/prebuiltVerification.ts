/**
 * The checksum both tiers verify a shipped binary with.
 *
 * Tier 1 loads its `.so` into the user's compositor process and Tier 2 execs
 * its helper against the user's Wayland socket, so both are about as trusted as
 * code gets on a desktop and both are verified the same way. This lived in
 * `kwinPluginProvisioning.ts` and was imported across from the portal tier,
 * which made a KDE-specific module a dependency of every wlroots desktop; it is
 * tier-agnostic, so it lives on its own.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * Verified before it is installed, not after.
 *
 * A truncated download is the likely case and a tampered file is the one that
 * matters; both are the same check. A file that cannot be read at all is a
 * failure rather than a throw, because every caller's next move is the same.
 */
export async function verifyPrebuilt(path: string, sha256: string): Promise<boolean> {
  const bytes = await readFile(path).catch(() => undefined);
  if (!bytes) return false;
  return createHash("sha256").update(bytes).digest("hex") === sha256;
}
