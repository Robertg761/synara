// FILE: credentialDigest.ts
// Purpose: Keyed digest + non-secret hint for pairing credentials stored at rest.
// Layer: Server auth
// Exports: PAIRING_CREDENTIAL_HINT_LENGTH, derivePairingCredentialDigest, derivePairingCredentialHint

import { signPayload } from "./utils";

export const PAIRING_CREDENTIAL_HINT_LENGTH = 4;

const PAIRING_DIGEST_DOMAIN = "synara/auth/pairing-credential/v1:";

/**
 * HMAC-SHA256 under server-held key material, so a database copy alone cannot
 * replay a pairing credential. The domain prefix keeps this digest from ever
 * colliding with another payload signed by the same key.
 */
export function derivePairingCredentialDigest(credential: string, secret: Uint8Array): string {
  return signPayload(`${PAIRING_DIGEST_DOMAIN}${credential}`, secret);
}

/**
 * A short prefix an owner can recognize in a listing. Deliberately far too
 * small to narrow a brute force within a pairing credential's lifetime.
 */
export function derivePairingCredentialHint(credential: string): string {
  return credential.slice(0, PAIRING_CREDENTIAL_HINT_LENGTH);
}
