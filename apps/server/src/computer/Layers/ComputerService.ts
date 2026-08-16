import { Effect, Layer } from "effect";
import type { ComputerAvailability } from "@synara/contracts";

import { ComputerManager } from "../ComputerManager.ts";
import { FakeComputerBackend } from "../FakeComputerBackend.ts";
import { KWinComputerBackend } from "../KWinComputerBackend.ts";
import { ComputerService, type ComputerServiceShape } from "../Services/ComputerService.ts";
import type { ComputerBackend } from "../ComputerBackend.ts";

export interface ComputerServiceLiveOptions {
  /** Inject a real or fake backend. */
  readonly backend?: ComputerBackend;
  /** Test/embedding override for the final availability decision. */
  readonly supported?: boolean;
}

export function makeComputerServiceLayer(options: ComputerServiceLiveOptions = {}) {
  return Layer.effect(
    ComputerService,
    Effect.gen(function* () {
      const backend =
        options.backend ??
        (process.platform === "linux" ? new KWinComputerBackend() : new FakeComputerBackend());
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

export const ComputerServiceLive = makeComputerServiceLayer();
