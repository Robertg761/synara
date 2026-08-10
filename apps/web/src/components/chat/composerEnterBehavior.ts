// FILE: composerEnterBehavior.ts
// Purpose: Decide whether a composer Enter keypress sends the prompt or inserts a newline.
// Layer: UI logic helper (pure)
// Exports: shouldComposerEnterSend

/**
 * Plain Enter sends on a fine pointer (mouse / trackpad). On a coarse pointer the
 * on-screen keyboard's Return key is the only newline affordance a finger has — and
 * it is the key people hit while composing — so Enter inserts a newline there and
 * sending goes through the composer's send button instead.
 *
 * Shift+Enter always inserts a newline, on every pointer; on a coarse pointer plain
 * Enter simply joins it.
 *
 * Pointer coarseness is the ONLY axis this may consider: it is a touch affordance,
 * not a layout decision. A narrow desktop window still sends on Enter, and a
 * touchscreen laptop does not — never derive this from viewport width
 * (`useLayoutMode`) or shell platform (`isMobileShell` / `isElectron`).
 */
export function shouldComposerEnterSend(input: {
  shiftKey: boolean;
  isCoarsePointer: boolean;
}): boolean {
  if (input.shiftKey) {
    return false;
  }
  return !input.isCoarsePointer;
}
