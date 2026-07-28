// Purpose: project the resolved mobile-access policy into the owner-facing status.
// Layer: server mobile support

import type { EnvironmentId, MobileAccessStatus } from "@synara/contracts";

import type { ServerMobileAccessConfig } from "../config";

export function toMobileAccessStatus(
  mobileAccess: ServerMobileAccessConfig,
  environmentId: EnvironmentId,
): MobileAccessStatus {
  const { resolution } = mobileAccess;
  return {
    enabled: resolution.enabled,
    mode: resolution.mode,
    reachability: resolution.reachability,
    environmentId,
    pairingBaseUrl: resolution.pairingBaseUrl,
    pairingBlockedReason: resolution.pairingBlockedReason,
    insecureDevelopmentAccess: resolution.insecureDevelopmentAccess,
    privateLanAvailable: mobileAccess.privateLanAvailable,
    desktopManaged: mobileAccess.desktopManaged,
    approvedRoots: mobileAccess.approvedRoots,
  };
}
