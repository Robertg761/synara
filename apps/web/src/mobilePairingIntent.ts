// Pairing credentials stay in memory, never in navigation URLs or renderer storage.
export interface MobilePairingIntent {
  readonly serverUrl: string;
  readonly credential: string;
}

export function parseMobilePairingIntent(value: string): MobilePairingIntent | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "synara:" || url.hostname !== "pair") return null;
    const server = new URL(url.searchParams.get("server") ?? "");
    const credential = url.searchParams.get("token");
    if (
      server.protocol !== "https:" || server.username || server.password ||
      server.search || server.hash || (server.pathname !== "/" && server.pathname !== "") ||
      !credential?.trim()
    ) return null;
    return { serverUrl: server.origin, credential };
  } catch {
    return null;
  }
}

let pending: MobilePairingIntent | null = null;
const listeners = new Set<() => void>();

export function receiveMobilePairingIntent(intent: MobilePairingIntent): void {
  pending = intent;
  for (const listener of listeners) listener();
}

export function consumeMobilePairingIntent(): MobilePairingIntent | null {
  const intent = pending;
  pending = null;
  return intent;
}

export function subscribeMobilePairingIntent(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
