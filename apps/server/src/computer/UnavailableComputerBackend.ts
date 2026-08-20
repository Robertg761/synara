/**
 * A backend that exists only to carry the reason there is no backend.
 *
 * Backend selection can fail in ways that happen before any display server is
 * contacted: a nested compositor that did not boot, an operator override naming
 * a backend Synara does not have. The service still needs a `ComputerBackend`
 * to hand the manager, and the alternative — leaving it undefined and
 * special-casing every reader — loses the one thing worth keeping, which is the
 * sentence explaining what went wrong.
 *
 * So the failure is the backend. `availability()` reports it, `health()`
 * reports it as the last failure, `capabilities()` is empty because nothing is
 * possible, and every action rejects with the same words. An operator reading
 * the availability card and an agent reading a tool error see one message, not
 * two descriptions of the same fault.
 */
import type {
  ComputerAvailability,
  ComputerCapabilities,
  ComputerHealth,
  ComputerId,
  ComputerLaunchAppResult,
  ComputerScreenSize,
  ComputerScreenshot,
  ComputerState,
  ComputerWindow,
} from "@synara/contracts";

import {
  clampComputerMessage,
  ComputerBackendError,
  NO_COMPUTER_CAPABILITIES,
  type ComputerBackend,
  type ComputerBackendEventListener,
} from "./ComputerBackend.ts";

const DEFAULT_COMPUTER_ID = "primary" as ComputerId;
const FALLBACK_MESSAGE = "The Synara computer backend is unavailable for an unstated reason.";

export class UnavailableComputerBackend implements ComputerBackend {
  readonly computerId: ComputerId;

  private readonly message: string;
  private readonly at: string;

  constructor(
    message: string,
    options: { readonly computerId?: string; readonly now?: () => number } = {},
  ) {
    this.computerId = (options.computerId ?? DEFAULT_COMPUTER_ID) as ComputerId;
    this.message = clampComputerMessage(message, FALLBACK_MESSAGE);
    this.at = new Date((options.now ?? Date.now)()).toISOString();
  }

  availability(): Promise<ComputerAvailability> {
    return Promise.resolve({ kind: "backend-unavailable", message: this.message });
  }

  /** The failure is already known and already free to read, so both agree. */
  probeAvailability(): Promise<ComputerAvailability> {
    return this.availability();
  }

  health(): ComputerHealth {
    return {
      status: "unavailable",
      consecutiveFailures: 1,
      reconnects: 0,
      lastFailure: { message: this.message, at: this.at },
      captureAvailable: false,
    };
  }

  capabilities(): ComputerCapabilities {
    return NO_COMPUTER_CAPABILITIES;
  }

  listWindows(): Promise<readonly ComputerWindow[]> {
    return this.refuse();
  }

  getScreenSize(): Promise<ComputerScreenSize> {
    return this.refuse();
  }

  getState(): Promise<ComputerState> {
    return this.refuse();
  }

  captureScreenshot(): Promise<ComputerScreenshot> {
    return this.refuse();
  }

  launchApp(): Promise<ComputerLaunchAppResult> {
    return this.refuse();
  }

  click(): Promise<never> {
    return this.refuse();
  }

  doubleClick(): Promise<never> {
    return this.refuse();
  }

  rightClick(): Promise<never> {
    return this.refuse();
  }

  moveCursor(): Promise<never> {
    return this.refuse();
  }

  drag(): Promise<never> {
    return this.refuse();
  }

  scroll(): Promise<never> {
    return this.refuse();
  }

  typeText(): Promise<never> {
    return this.refuse();
  }

  pressKey(): Promise<never> {
    return this.refuse();
  }

  hotkey(): Promise<never> {
    return this.refuse();
  }

  setValue(): Promise<never> {
    return this.refuse();
  }

  performAction(): Promise<never> {
    return this.refuse();
  }

  onEvent(_listener: ComputerBackendEventListener): () => void {
    // Nothing will ever change, so the subscription is a no-op rather than a
    // set that grows for the life of the process.
    return () => undefined;
  }

  attachStream(): Promise<void> {
    return this.refuse();
  }

  detachStream(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): void {}

  private refuse(): Promise<never> {
    return Promise.reject(new ComputerBackendError(this.message, { retryable: false }));
  }
}
