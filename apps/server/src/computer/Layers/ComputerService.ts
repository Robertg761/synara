import { Effect, Layer } from "effect";
import type { ComputerAvailability } from "@synara/contracts";

import { ComputerManager } from "../ComputerManager.ts";
import { FakeComputerBackend } from "../FakeComputerBackend.ts";
import { KWinComputerBackend } from "../KWinComputerBackend.ts";
import { UnavailableComputerBackend } from "../UnavailableComputerBackend.ts";
import {
  nestedModeForChoice,
  selectLinuxBackend,
  type LinuxBackendSelection,
} from "../linuxBackendSelection.ts";
import { sessionBusNameHasOwner } from "../sessionBusNames.ts";
import {
  nestedAtspiMode,
  nestedKWinBackendOptions,
  nestedModeLabel,
  parseNestedSizeEnv,
  startNestedKWinSession,
  type NestedKWinSession,
  type NestedSessionMode,
} from "../nestedKWinSession.ts";
import { createPortalComputerBackend } from "../portal/PortalComputerBackend.ts";
import { probeDesktop } from "../portal/probe.ts";
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
        // The passive probe, never the establishing read. Boot runs for every
        // user of every build, and `availability()` on KWin connects, installs
        // the plugin — compiling it from source on a cold machine — and loads
        // it into the live compositor. Nobody has asked for a desktop yet at
        // this point, so nothing may be done to theirs; the first real use is
        // what provisions, and it reports its own failure if it cannot.
        availability = yield* Effect.promise(() => backend.probeAvailability());
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
        // reachable KWin user bus, and a plugin that is loaded, installed,
        // shipped for this KWin, or buildable here.
        supported: options.supported ?? availability?.kind === "available",
        availability,
        manager,
      } satisfies ComputerServiceShape;
    }),
  );
}

/**
 * Builds whichever backend `selectLinuxBackend` resolved, with no fallback in
 * any direction: a tier that fails stays failed and its backend carries the
 * reason. See `linuxBackendSelection.ts` for the order and why it probes the
 * session bus rather than reading `XDG_CURRENT_DESKTOP`.
 *
 * On a KDE host with none of these environment variables set, this is still a
 * bare `new KWinComputerBackend()` — the same object, with the same defaults,
 * as before Tier 2 existed.
 */
async function makeLinuxBackend(): Promise<LinuxBackend> {
  let selection: LinuxBackendSelection;
  try {
    selection = await selectLinuxBackend({ busNameHasOwner: sessionBusNameHasOwner });
  } catch (error) {
    // Only a malformed SYNARA_COMPUTER_BACKEND reaches here, and it must not
    // take the server down: an operator typo becomes an availability card that
    // lists the backends that do exist.
    return { backend: new UnavailableComputerBackend(describeError(error)) };
  }
  switch (selection.choice) {
    case "kwin":
      return { backend: new KWinComputerBackend() };
    case "nested":
    case "nested-window":
      return await makeNestedBackend(nestedModeForChoice(selection.choice) ?? "virtual");
    case "portal":
      return { backend: createPortalComputerBackend(await probeDesktop()) };
  }
}

/**
 * A private compositor this process owns, with the geometry from
 * `SYNARA_COMPUTER_NESTED_SIZE=WxH`. One that fails to boot stays failed:
 * falling back to the real desktop would hand an agent the human's screen right
 * after an operator asked for an isolated one.
 */
async function makeNestedBackend(mode: NestedSessionMode): Promise<LinuxBackend> {
  const size = parseNestedSizeEnv(process.env.SYNARA_COMPUTER_NESTED_SIZE);
  let session: NestedKWinSession;
  try {
    session = await startNestedKWinSession(size ? { mode, size } : { mode });
  } catch (error) {
    // The mode is part of the message: the two boot different things and fail
    // for different reasons — a missing kwin_wayland, an uninstalled plugin, a
    // bus that never answered, no host display to nest into.
    return {
      backend: new UnavailableComputerBackend(
        `The ${nestedModeLabel(mode)} nested KWin session did not start: ${describeError(error)}`,
      ),
    };
  }
  return {
    backend: new KWinComputerBackend(
      nestedKWinBackendOptions(session, { atspiMode: nestedAtspiMode() }),
    ),
    dispose: () => session.dispose(),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const ComputerServiceLive = makeComputerServiceLayer();
