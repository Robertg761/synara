// FILE: mobileBackStack.ts
// Purpose: Route a phone/Android back gesture to the topmost dismissable surface
//          before it is allowed to pop history or leave the app.
// Layer: Web shell navigation primitive
// Exports: registerBackDismissable, handleMobileBack, resetMobileBackStackForTests

/** Returns true when the back press was consumed (a sheet closed, a menu dismissed, ...). */
export type BackDismissable = () => boolean;

export type MobileBackNavigation = {
  canGoBack: () => boolean;
  goBack: () => void;
};

export type MobileBackOutcome = "dismissed" | "navigated" | "exit";

/** LIFO: the most recently opened surface gets the back press first. */
const dismissables: BackDismissable[] = [];

/**
 * Registers a dismissable surface for the duration of its lifetime.
 *
 * Returns an unregister function that is safe to call more than once (effect
 * cleanups can run twice under StrictMode) and that removes exactly the
 * registration it belongs to, even if the same callback identity was registered
 * by two surfaces at once.
 */
export function registerBackDismissable(fn: BackDismissable): () => void {
  dismissables.push(fn);
  let registered = true;

  return () => {
    if (!registered) return;
    registered = false;
    const index = dismissables.lastIndexOf(fn);
    if (index !== -1) dismissables.splice(index, 1);
  };
}

/**
 * Resolves one back press.
 *
 * Walks the registry from the top and stops at the first handler that reports it
 * consumed the press. Handlers that decline are skipped for this press only —
 * they stay registered, because "nothing to dismiss right now" is a transient
 * state (a collapsed panel that can reopen). Falls through to history, then to
 * "exit" so the shell can decide whether to background or close the app.
 */
export function handleMobileBack(navigation: MobileBackNavigation): MobileBackOutcome {
  // Snapshot: a handler may register or unregister surfaces while dismissing.
  const snapshot = [...dismissables];
  for (let index = snapshot.length - 1; index >= 0; index -= 1) {
    if (snapshot[index]?.()) return "dismissed";
  }

  if (navigation.canGoBack()) {
    navigation.goBack();
    return "navigated";
  }

  return "exit";
}

export function resetMobileBackStackForTests(): void {
  dismissables.length = 0;
}
