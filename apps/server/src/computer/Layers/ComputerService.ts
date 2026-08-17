import { Effect, Layer } from "effect";
import type { ComputerAvailability } from "@synara/contracts";

import { ComputerManager } from "../ComputerManager.ts";
import { ComputerBackendError } from "../ComputerBackend.ts";
import { FakeComputerBackend } from "../FakeComputerBackend.ts";
import { KWinComputerBackend } from "../KWinComputerBackend.ts";
import {
  nestedAtspiMode,
  nestedKWinBackendOptions,
  nestedModeLabel,
  nestedSessionMode,
  parseNestedSizeEnv,
  startNestedKWinSession,
  type NestedKWinSession,
  type NestedSessionMode,
} from "../nestedKWinSession.ts";
import { ComputerService, type ComputerServiceShape } from "../Services/ComputerService.ts";
import type { ComputerBackend } from "../ComputerBackend.ts";

export interface ComputerServiceLiveOptions {
  /** Inject a real or fake backend. */
  readonly backend?: ComputerBackend;
  /** Test/embedding override for the final availability decision. */
  readonly supported?: boolean;
}

interface LinuxBackend {
  readonly backend: ComputerBackend;
  readonly dispose?: () => Promise<void>;
}

export function makeComputerServiceLayer(options: ComputerServiceLiveOptions = {}) {
  return Layer.effect(
    ComputerService,
    Effect.gen(function* () {
      const linux =
        options.backend === undefined && process.platform === "linux"
          ? yield* Effect.promise(() => makeLinuxBackend())
          : undefined;
      const backend = options.backend ?? linux?.backend ?? new FakeComputerBackend();
      // Registered before the manager's finalizer because a scope runs
      // finalizers in reverse: the backend is disposed first, so nothing is
      // still talking to the nested compositor when it is killed.
      const nestedDispose = linux?.dispose;
      if (nestedDispose) {
        yield* Effect.addFinalizer(() => Effect.promise(() => nestedDispose()));
      }
      const manager = new ComputerManager({ backend });
      yield* Effect.addFinalizer(() => Effect.promise(() => manager.dispose()));
      let availability: ComputerAvailability;
      if (options.supported === undefined) {
        availability = yield* Effect.promise(() => backend.availability());
      } else if (options.supported) {
        availability = { kind: "available", backend: "test-override" };
      } else {
        availability = {
          kind: "backend-unavailable",
          message: "Computer support is disabled by the service configuration.",
        };
      }
      return {
        // The backend performs the complete Linux gate: Linux, Wayland, a
        // reachable KWin user bus, and a loaded or installed plugin.
        supported: options.supported ?? availability?.kind === "available",
        availability,
        manager,
      } satisfies ComputerServiceShape;
    }),
  );
}

/**
 * Tier 1 by default: the KWin backend drives the session the user is sitting
 * in. `SYNARA_COMPUTER_NESTED` opts into a private compositor this process owns
 * instead — `1` for the headless Tier 3 session, `window` for the Tier 2 one
 * that nests as a window in the host session — with the geometry from
 * `SYNARA_COMPUTER_NESTED_SIZE=WxH`.
 *
 * A nested session that fails to boot stays failed. Falling back to the real
 * desktop would hand an agent the human's screen right after an operator asked
 * for an isolated one, and falling the other way would hide a broken desktop
 * behind a nested session nobody can see.
 */
async function makeLinuxBackend(): Promise<LinuxBackend> {
  const mode = nestedSessionMode();
  if (mode === undefined) return { backend: new KWinComputerBackend() };
  const size = parseNestedSizeEnv(process.env.SYNARA_COMPUTER_NESTED_SIZE);
  let session: NestedKWinSession;
  try {
    session = await startNestedKWinSession(size ? { mode, size } : { mode });
  } catch (error) {
    return { backend: unavailableNestedBackend(mode, error) };
  }
  return {
    backend: new KWinComputerBackend(
      nestedKWinBackendOptions(session, { atspiMode: nestedAtspiMode() }),
    ),
    dispose: () => session.dispose(),
  };
}

/**
 * A backend whose every call fails with the reason the nested session did not
 * come up, so the availability card and any tool call name the same missing
 * piece — a missing kwin_wayland, an uninstalled plugin, a bus that never
 * answered, no host display to nest into — instead of a generic connection
 * error. The mode is part of that: the two boot different things and fail for
 * different reasons.
 */
function unavailableNestedBackend(mode: NestedSessionMode, error: unknown): ComputerBackend {
  const message = `The ${nestedModeLabel(mode)} nested KWin session did not start: ${error instanceof Error ? error.message : String(error)}`;
  return new KWinComputerBackend({
    sessionType: "wayland",
    dbusFactory: () => Promise.reject(new ComputerBackendError(message)),
  });
}

export const ComputerServiceLive = makeComputerServiceLayer();
