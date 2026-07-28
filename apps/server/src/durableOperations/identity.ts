import { createHash } from "node:crypto";

export function operationIsoNow(): string {
  return new Date().toISOString();
}

/**
 * Key-sorted JSON with `undefined` removed. Durable operation identity depends
 * on this being stable across processes and property insertion order.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function stableOperationDigest(value: unknown, length = 32): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, length);
}
