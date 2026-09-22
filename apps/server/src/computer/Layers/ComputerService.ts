import { join } from "node:path";
import { ServerConfig } from "../../config.ts";
import { Effect, Layer, Option } from "effect";
import type { ComputerAvailability } from "@synara/contracts";

import { CUA_HOST_SOCKET_ENV } from "@synara/shared/cuaDriverProtocol";
import { ComputerManager } from "../ComputerManager.ts";
import { CuaComputerBackend } from "../CuaComputerBackend.ts";
import { FakeComputerBackend } from "../FakeComputerBackend.ts";
import { UnavailableComputerBackend } from "../UnavailableComputerBackend.ts";
import { ComputerService, type ComputerServiceShape } from "../Services/ComputerService.ts";
import type { ComputerBackend } from "../ComputerBackend.ts";
import {
  isLinuxBackendChoice,
  parseComputerBackendOverride,
  selectLinuxBackend,
  type ComputerBackendOverride,
  type LinuxBackendChoice,
  type LinuxBackendSelection,
  type LinuxBackendSelectionDependencies,
} from "../linuxBackendSelection.ts";
import { resolveBrowserHostCapability } from "../../browserAutomation/browserHostRpcClient.ts";
import {
  activeComputerGuidanceProfile,
  setActiveComputerGuidanceProfile,
} from "../../agentGateway/computerGuidance.ts";

export interface ComputerServiceLiveOptions {
  /** Inject a real or fake backend. */
  readonly backend?: ComputerBackend;
  /** Test/embedding override for the final availability decision. */
  readonly supported?: boolean;
  /** Test override for the host platform; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /**
   * Test override for backend selection: the environment the override, the
   * host socket and the Linux tiers are read from (defaults to the process
   * environment), and the Linux detection probes (default to the live host).
   */
  readonly selection?: Omit<LinuxBackendSelectionDependencies, "override">;
}

/**
 * The constructor behind each Linux choice. Keyed by the choice so a backend
 * that registers a tier in `linuxBackendSelection.ts` cannot forget to say how
 * it is built; the type fails the build otherwise.
 */
const LINUX_BACKENDS: Record<LinuxBackendChoice, () => ComputerBackend> = {};

let warnedMissingControlStatePath = false;

export function makeComputerServiceLayer(options: ComputerServiceLiveOptions = {}) {
  return Layer.effect(
    ComputerService,
    Effect.gen(function* () {
      const platform = options.platform ?? process.platform;
      const backend =
        options.backend ??
        (yield* Effect.promise(() => selectBackend(platform, options.selection)));
      const config = yield* Effect.serviceOption(ServerConfig);
      if (Option.isNone(config) && !warnedMissingControlStatePath) {
        warnedMissingControlStatePath = true;
        yield* Effect.logWarning(
          "computer control state path unavailable; using in-memory control state",
        );
      }
      const manager = new ComputerManager({
        backend,
        ...(Option.isSome(config)
          ? {
              controlStatePath: join(config.value.stateDir, "computer-control.json"),
              // Beside the control state: the bounded mutating-call audit log,
              // local-only and dropped-oldest past its caps.
              auditLogPath: join(config.value.stateDir, "computer-audit.jsonl"),
            }
          : {}),
      });
      // The session-start guidance describes the one desktop this process
      // drives, and it is rendered by provider adapters that never see the
      // backend, so the manager's profile is registered here — where the
      // backend is chosen — for the lifetime of the service, and cleared only
      // if it is still the one this service registered.
      const guidanceProfile = manager.guidanceProfile;
      setActiveComputerGuidanceProfile(guidanceProfile);
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          if (activeComputerGuidanceProfile() === guidanceProfile) {
            setActiveComputerGuidanceProfile(undefined);
          }
          await manager.dispose();
        }),
      );
      let availability: ComputerAvailability;
      if (options.supported === undefined) {
        // The passive probe, never the establishing read. Boot runs for every
        // user of every build, long before anyone has asked for a desktop —
        // and on a Linux compositor backend the establishing read installs a
        // plugin and loads it into the live desktop.
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
        // Supported backends remain routable even before setup grants access.
        supported: options.supported ?? !(backend instanceof UnavailableComputerBackend),
        availability,
        manager,
      } satisfies ComputerServiceShape;
    }),
  );
}

/**
 * The backend this server drives, in order: the explicit override, the Linux
 * tier that claims this host, the Cua host where one is reachable, and
 * otherwise a backend that says why there is none.
 *
 * An override is honored or refused, never bypassed: a malformed value and a
 * Linux choice off Linux both become the unavailable backend carrying the
 * reason, so an operator typo shows up as an availability card listing the
 * backends that do exist rather than as a different backend that seems to
 * ignore the variable.
 *
 * Cua comes after the Linux tiers on purpose. The desktop app always
 * configures its host socket, on Linux too, so socket presence cannot be what
 * decides between a compositor backend and the observation-only Cua host;
 * Cua on Linux is reached by naming it, or as what is left when no tier
 * claims the host.
 */
async function selectBackend(
  platform: NodeJS.Platform,
  selection: Omit<LinuxBackendSelectionDependencies, "override"> | undefined,
): Promise<ComputerBackend> {
  const env = selection?.env ?? process.env;
  let override: ComputerBackendOverride | undefined;
  try {
    override = parseComputerBackendOverride(env.SYNARA_COMPUTER_BACKEND);
  } catch (error) {
    return new UnavailableComputerBackend(describeError(error));
  }
  if (override === "fake") return new FakeComputerBackend();
  if (override === "cua") return makeCuaBackend();
  if (isLinuxBackendChoice(override) && platform !== "linux") {
    return new UnavailableComputerBackend(
      `SYNARA_COMPUTER_BACKEND=${override} names a Linux desktop backend, and this server runs on ${platform}.`,
      { availability: { kind: "unsupported-platform", platform } },
    );
  }
  if (platform === "linux") {
    const linux = await selectLinuxBackend({
      ...selection,
      ...(isLinuxBackendChoice(override) ? { override } : {}),
    });
    if (linux) return makeLinuxBackend(linux);
  }
  // macOS runs the bundled host the desktop app provisions; on other
  // platforms the same backend is routable when a host endpoint is
  // configured explicitly (the provisioned upstream driver serving the
  // same socket protocol). No endpoint means no backend — the gate is
  // reachability, never platform optimism.
  const hostEndpoint = env[CUA_HOST_SOCKET_ENV]?.trim();
  if (platform === "darwin" || hostEndpoint) return makeCuaBackend();
  return new UnavailableComputerBackend(
    `No computer backend is configured for this server running on ${platform}.`,
    {
      availability:
        platform === "linux"
          ? {
              kind: "backend-unavailable",
              message: "No computer backend is available on this server.",
            }
          : { kind: "unsupported-platform", platform },
    },
  );
}

function makeLinuxBackend(selection: LinuxBackendSelection): ComputerBackend {
  const make: () => ComputerBackend = LINUX_BACKENDS[selection.choice];
  return make();
}

function makeCuaBackend(): ComputerBackend {
  return new CuaComputerBackend({ capability: resolveBrowserHostCapability() ?? undefined });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const ComputerServiceLive = makeComputerServiceLayer();
