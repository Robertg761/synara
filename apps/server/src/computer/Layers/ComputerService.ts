import { Effect, Layer } from "effect";
import type { ComputerAvailability } from "@synara/contracts";

import { ComputerManager } from "../ComputerManager.ts";
import { FakeComputerBackend } from "../FakeComputerBackend.ts";
import { HyprlandComputerBackend } from "../HyprlandComputerBackend.ts";
import { KWinComputerBackend } from "../KWinComputerBackend.ts";
import { UnavailableComputerBackend } from "../UnavailableComputerBackend.ts";
import {
  nestedModeForChoice,
  selectLinuxBackend,
  type LinuxBackendSelection,
} from "../linuxBackendSelection.ts";
import { sessionBusNameHasOwner } from "../sessionBusNames.ts";
import { NestedComputerBackend } from "../nestedComputerBackend.ts";
import { nestedAtspiMode, parseNestedSizeEnv } from "../nestedKWinSession.ts";
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
    case "hyprland":
      // The same real-desktop tier as KWin, on a Hyprland session: the plugin
      // loads live through hyprctl, so construction touches nothing.
      return { backend: new HyprlandComputerBackend() };
    case "nested":
    case "nested-window": {
      // Constructed, not booted: the nested compositor is expensive and — in
      // window mode — visible, so nothing may appear because a server started.
      // The backend boots its session on first real use, and its `provision()`
      // is the settings panel's one-click setup. The geometry comes from
      // `SYNARA_COMPUTER_NESTED_SIZE=WxH`. A session that fails to boot stays
      // failed: falling back to the real desktop would hand an agent the
      // human's screen right after an operator asked for an isolated one.
      const size = parseNestedSizeEnv(process.env.SYNARA_COMPUTER_NESTED_SIZE);
      return {
        backend: new NestedComputerBackend({
          mode: nestedModeForChoice(selection.choice) ?? "virtual",
          ...(size ? { size } : {}),
          atspiMode: nestedAtspiMode(),
        }),
      };
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const ComputerServiceLive = makeComputerServiceLayer();
