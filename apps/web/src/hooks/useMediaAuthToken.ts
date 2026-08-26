// FILE: useMediaAuthToken.ts
// Purpose: Re-renders a component when the media credential rotates, so URLs it builds during
//          render are rebuilt against the current one instead of the one that was current when
//          the component last happened to render for another reason.
// Layer: Web hook
// Depends on: ~/mediaAuthToken
// Exports: useMediaAuthToken

import { useSyncExternalStore } from "react";

import { readMediaAuthToken, subscribeMediaAuthToken } from "../mediaAuthToken";

/**
 * The current media credential, or null on every runtime that does not need one. The value is
 * rarely read directly — callers want the re-render, and build their URLs through
 * `resolveMediaHttpUrl` as usual.
 */
export function useMediaAuthToken(): string | null {
  return useSyncExternalStore(subscribeMediaAuthToken, readMediaAuthToken, () => null);
}
