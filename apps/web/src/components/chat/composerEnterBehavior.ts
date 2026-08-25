// FILE: composerEnterBehavior.ts
// Purpose: Decide whether a composer Enter keypress sends the prompt or inserts a newline.
// Layer: UI logic helper (pure)
// Exports: shouldComposerEnterSend, shouldComposerEnterUseOppositeFollowUp

/**
 * Plain Enter sends on a fine pointer (mouse / trackpad). On a coarse pointer the
 * on-screen keyboard's Return key is the only newline affordance a finger has — and
 * it is the key people hit while composing — so Enter inserts a newline there and
 * sending goes through the composer's send button instead.
 *
 * Shift+Enter always inserts a newline, on every pointer; on a coarse pointer plain
 * Enter simply joins it.
 *
 * Ctrl/Cmd+Enter always sends, on every pointer. That is the escape hatch for a coarse-pointer
 * device with a HARDWARE keyboard (iPad + Magic Keyboard, an Android tablet in a case): the
 * pointer stays coarse, so plain Enter still writes a newline, but someone typing on real keys
 * keeps a keyboard-only way to send. Hardware keyboards are deliberately NOT auto-detected —
 * there is no reliable signal for one, and guessing wrong would silently take Enter away from
 * touch typists or hand it to thumbs.
 *
 * Pointer coarseness is the ONLY device axis this may consider: it is a touch affordance,
 * not a layout decision. A narrow desktop window still sends on Enter, and a
 * touchscreen laptop does not — never derive this from viewport width
 * (`useLayoutMode`) or shell platform (`isMobileShell` / `isElectron`).
 */
export function shouldComposerEnterSend(input: {
  shiftKey: boolean;
  isCoarsePointer: boolean;
  /** Ctrl or Cmd held — the hardware-keyboard send path on a coarse pointer. */
  modifierKey: boolean;
}): boolean {
  if (input.shiftKey) {
    return false;
  }
  if (input.modifierKey) {
    return true;
  }
  return !input.isCoarsePointer;
}

/**
 * Whether a sending Enter asks for the OPPOSITE follow-up dispatch (queue vs. interrupt) of the
 * user's configured default — see `resolveFollowUpDispatchMode` in `appSettings`.
 *
 * Ctrl/Cmd is that modifier on a fine pointer. On a coarse pointer it is instead the only way to
 * send at all ({@link shouldComposerEnterSend}), so it must NOT double as the opposite-behavior
 * modifier there: an iPad user's only keyboard send would otherwise always take the branch they
 * did not configure.
 */
export function shouldComposerEnterUseOppositeFollowUp(input: {
  isCoarsePointer: boolean;
  modifierKey: boolean;
}): boolean {
  return input.modifierKey && !input.isCoarsePointer;
}
