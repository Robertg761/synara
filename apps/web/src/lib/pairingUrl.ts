// FILE: pairingUrl.ts
// Purpose: Builds the /pair URL a remote device opens to claim a pairing credential.
// Layer: Web utility

/**
 * Mirrors the server's startup pairing URL shape (`ServerAuth.issueStartupPairingUrl`):
 * the credential travels in the fragment so it never reaches server logs or proxies.
 */
export function makePairingUrl(origin: string, credential: string): string {
  const url = new URL(origin);
  url.pathname = "/pair";
  url.search = "";
  url.hash = new URLSearchParams([["token", credential]]).toString();
  return url.toString();
}
