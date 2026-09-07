// FILE: mediaProbeCache.ts
// Purpose: A memo for "did this media asset load?" that does not remember failures across a
//          change of credential. Favicons and project icons are probed with `Image()` and their
//          outcome cached so later renders settle instantly — but on the mobile shell a probe run
//          before the media credential arrived fails with 401, and a plain cache would serve that
//          "missing" verdict forever, long after the credential showed up.
// Layer: Web utility
// Depends on: ~/mediaAuthToken (the credential in force when an outcome was observed)
// Exports: createMediaProbeCache, MediaProbeCache

import { readMediaAuthToken } from "../mediaAuthToken";

export interface MediaProbeCache<T> {
  /** The remembered outcome, or undefined when there is none worth trusting any more. */
  get(key: string): T | undefined;
  /**
   * Remember an outcome. `credential` is the one the probe actually ran with — pass it explicitly
   * when the probe started earlier than it finished, so a rotation mid-flight does not file the
   * result under a credential that never produced it.
   */
  set(key: string, value: T, credential?: string | null): void;
  /** Every remembered outcome, positive or not, is forgotten. Test seam. */
  clear(): void;
}

/**
 * `isNegative` marks the outcomes that a missing or stale credential could have caused. Positive
 * outcomes are kept unconditionally: an asset that loaded, loaded.
 */
export function createMediaProbeCache<T>(isNegative: (value: T) => boolean): MediaProbeCache<T> {
  const entries = new Map<string, { readonly value: T; readonly credential: string | null }>();
  return {
    get(key) {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      if (isNegative(entry.value) && entry.credential !== readMediaAuthToken()) {
        // Recorded under a credential this client no longer holds: worth one more look.
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value, credential) {
      entries.set(key, {
        value,
        credential: credential === undefined ? readMediaAuthToken() : credential,
      });
    },
    clear() {
      entries.clear();
    },
  };
}
