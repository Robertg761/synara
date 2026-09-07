// FILE: signedOutScreenCopy.ts
// Purpose: Single source of the signed-out screen's copy, shared by the pre-React static
//          renderer (authSignedOut.ts) and the in-app route (routes/signed-out.tsx).
// Layer: Web utility
// Exports: SIGNED_OUT_SCREEN
// Depends on: nothing — authSignedOut.ts renders before React loads, so this must stay
//             dependency-free.

/**
 * The two renderers differ only in how they paint (raw DOM with inline styles before React is
 * loaded, themed components after); the words and structure must never diverge.
 */
export const SIGNED_OUT_SCREEN = {
  documentTitle: "Signed out · Synara",
  headingId: "signed-out-title",
  eyebrow: "Session closed",
  heading: "This browser no longer controls Synara.",
  body: "The session and its live connections were revoked. To reconnect, generate a fresh pairing link from an active owner session and open it in this browser.",
} as const;
