// FILE: mobileProviderStatuses.ts
// Purpose: Projection of server provider health onto the `mobile.v1` status
//          payload shared by `provider.listProviders` and the status stream.
// Layer: Server mobile transport
// Exports: toMobileProviderStatus, toMobileProviderStatuses

import {
  PROVIDER_DISPLAY_NAMES,
  type MobileProviderStatus,
  type MobileProviderStatuses,
  type ServerProviderStatus,
} from "@synara/contracts";
import { getDefaultModel } from "@synara/shared/model";

export const toMobileProviderStatus = (status: ServerProviderStatus): MobileProviderStatus => ({
  provider: status.provider,
  displayName: PROVIDER_DISPLAY_NAMES[status.provider],
  available: status.available,
  authStatus: status.authStatus,
  defaultModel: getDefaultModel(status.provider),
  supportsAutoRuntimeMode: status.supportsAutoRuntimeMode ?? false,
  checkedAt: status.checkedAt,
  ...(status.message === undefined ? {} : { message: status.message }),
});

export const toMobileProviderStatuses = (
  providers: ReadonlyArray<ServerProviderStatus>,
  updatedAt: string,
): MobileProviderStatuses => ({
  providers: providers.map(toMobileProviderStatus),
  updatedAt,
});
