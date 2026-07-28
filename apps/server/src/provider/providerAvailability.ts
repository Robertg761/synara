import type { ProviderKind, ServerProviderStatus } from "@synara/contracts";
import { Effect } from "effect";

import { PROVIDER_KINDS } from "../agentGateway/toolInput.ts";
import type { AgentGatewayProviderAvailability } from "../agentGateway/targetResolver.ts";
import type { ProviderHealthShape } from "./Services/ProviderHealth.ts";
import type { ServerSettingsShape } from "../serverSettings.ts";

/**
 * Project enablement settings and live health onto the availability view every
 * authoritative target resolution consumes. Gateways must never resolve a
 * provider from settings alone: a disabled-and-unhealthy provider and a
 * healthy-but-disabled one are different rejections.
 */
export function loadProviderAvailabilities(input: {
  readonly settings: Pick<ServerSettingsShape, "getSettings">;
  readonly providerHealth: Pick<ProviderHealthShape, "getStatuses">;
}) {
  return Effect.gen(function* () {
    const [settings, statuses] = yield* Effect.all([
      input.settings.getSettings,
      input.providerHealth.getStatuses,
    ]);
    const statusByProvider = new Map<ProviderKind, ServerProviderStatus>(
      statuses.map((status) => [status.provider, status]),
    );
    return new Map<ProviderKind, AgentGatewayProviderAvailability>(
      PROVIDER_KINDS.map((provider) => {
        const status = statusByProvider.get(provider);
        return [
          provider,
          {
            enabled: settings.providers[provider].enabled,
            ...(status
              ? {
                  available: status.available,
                  authStatus: status.authStatus,
                  ...(status.message ? { message: status.message } : {}),
                }
              : {}),
          },
        ];
      }),
    );
  });
}
