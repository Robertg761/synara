// FILE: computerControlFirstUse.ts
// Purpose: Preflight the Synara-owned macOS privacy grants when a user turns computer control on.
// Layer: Web composer first-use policy
//
// This deliberately does NOT decide whether a message wants desktop control.
// That question already has three answers in this codebase — the harness policy
// tells the agent when to reach for `computer_*`, `promptRequestsExplicitComputerUse`
// answers it for the in-app browser path, and `generateAutomationIntent` answers
// it server-side with a model — and a regex in the browser is the least informed
// of them. It is also the wrong place to *grant* a privilege: Synara is a GUI
// for coding agents, so the words that would trigger such a heuristic ("open
// Safari", "click the button in the simulator", "debug computer use") are the
// words users type about their code all day.
//
// What is left is the part that genuinely belongs on the client: once the user
// has said yes — the composer switch, or Enable on a denial card — ask macOS for
// the grants through the signed desktop process, so the prompt is attributed to
// Synara rather than to an agent's shell.

import type { DesktopBridge, DesktopComputerControlPermissionState } from "@synara/contracts";

export type ComputerControlPermissionPreflight =
  | { readonly kind: "not-desktop" }
  | { readonly kind: "aborted" }
  | { readonly kind: "ready"; readonly state: DesktopComputerControlPermissionState }
  | { readonly kind: "permission-required"; readonly state: DesktopComputerControlPermissionState };

export interface ComputerControlPreflightOptions {
  /** Called once, before the first prompt, so the caller can say what is happening. */
  readonly onPermissionRequest?: (() => void) | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly timeoutMs?: number | undefined;
  /** Ends the wait early when the user navigates away or closes the view. */
  readonly signal?: AbortSignal | undefined;
  readonly sleep?: ((milliseconds: number, signal?: AbortSignal) => Promise<void>) | undefined;
  /** Injected so tests do not depend on the wall clock. */
  readonly now?: (() => number) | undefined;
}

/** Resolves after `milliseconds`, or immediately when `signal` aborts. */
function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Asks Electron main for the grants, prompting if they are missing, and waits a
 * bounded time for the user to answer the macOS dialog.
 *
 * Browser-only Synara instances have no desktop bridge; they report
 * `not-desktop` and let the backend surface its own platform-specific setup
 * state. The wait is abortable because it outlives the click that started it:
 * the user can close the view or switch chats while a System Settings pane is
 * open, and a poll loop that cannot be stopped keeps spawning helper processes
 * against a screen nobody is looking at.
 */
export async function preflightComputerControlPermissions(
  bridge: DesktopBridge["computerControl"] | undefined,
  options: ComputerControlPreflightOptions = {},
): Promise<ComputerControlPermissionPreflight> {
  if (!bridge) return { kind: "not-desktop" };
  if (options.signal?.aborted) return { kind: "aborted" };

  const current = await bridge.getPermissionState();
  if (!current.supported) return { kind: "not-desktop" };
  if (current.ready) return { kind: "ready", state: current };
  if (options.signal?.aborted) return { kind: "aborted" };

  options.onPermissionRequest?.();
  let latest = await bridge.requestPermissions();

  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const sleep = options.sleep ?? abortableSleep;
  // Monotonic where available: a clock change mid-wait must not end it early or
  // stretch it, and the caller may be waiting on a System Settings toggle.
  const now = options.now ?? (() => performance.now());
  const deadline = now() + timeoutMs;

  // Granting Screen Recording or Accessibility happens in System Settings,
  // after the request call has already returned. Polling briefly means flipping
  // the switch resumes the caller instead of needing a second attempt.
  while (!latest.ready && now() < deadline) {
    if (options.signal?.aborted) return { kind: "aborted" };
    await sleep(pollIntervalMs, options.signal);
    if (options.signal?.aborted) return { kind: "aborted" };
    latest = await bridge.getPermissionState();
  }
  return latest.ready
    ? { kind: "ready", state: latest }
    : { kind: "permission-required", state: latest };
}
