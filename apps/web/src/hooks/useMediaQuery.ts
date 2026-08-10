// FILE: useMediaQuery.ts
// Purpose: Subscribe React components to CSS media queries through one shared, per-query
//          external store, so a query costs the same whether one component or fifty read it.
// Layer: Web hook
// Exports: useMediaQuery, useIsMobile, useIsCoarsePointer, MediaQueryInput, getMediaQueryStore

import { useSyncExternalStore } from "react";

const BREAKPOINTS = {
  "2xl": 1536,
  "3xl": 1600,
  "4xl": 2000,
  lg: 1024,
  md: 768,
  sm: 640,
  xl: 1280,
} as const;

type Breakpoint = keyof typeof BREAKPOINTS;

type BreakpointQuery = Breakpoint | `max-${Breakpoint}` | `${Breakpoint}:max-${Breakpoint}`;

function resolveMin(value: Breakpoint | number): string {
  const px = typeof value === "number" ? value : BREAKPOINTS[value];
  return `(min-width: ${px}px)`;
}

function resolveMax(value: Breakpoint | number): string {
  const px = typeof value === "number" ? value : BREAKPOINTS[value];
  return `(max-width: ${px - 1}px)`;
}

/**
 * Parsed media-query text, keyed by the shorthand it came from. Shorthands are a tiny closed
 * set ("max-md", "md:max-lg", ...) and parsing them allocates, so the result is cached: this
 * runs on every render of every consumer, including ones that re-render per streaming update.
 */
const parsedQueryByShorthand = new Map<string, string>();

function parseQuery(query: BreakpointQuery | MediaQueryInput | (string & {})): string {
  if (typeof query !== "string") {
    const parts: string[] = [];
    if (query.min != null) parts.push(resolveMin(query.min));
    if (query.max != null) parts.push(resolveMax(query.max));
    if (query.pointer === "coarse") parts.push("(pointer: coarse)");
    if (query.pointer === "fine") parts.push("(pointer: fine)");
    if (parts.length === 0) return "(min-width: 0px)";
    return parts.join(" and ");
  }

  if (query.startsWith("(")) return query;

  const cached = parsedQueryByShorthand.get(query);
  if (cached !== undefined) return cached;

  const parts: string[] = [];
  for (const segment of query.split(":")) {
    if (segment.startsWith("max-")) {
      const bp = segment.slice(4);
      if (bp in BREAKPOINTS) parts.push(resolveMax(bp as Breakpoint));
    } else if (segment in BREAKPOINTS) {
      parts.push(resolveMin(segment as Breakpoint));
    }
  }

  const parsed = parts.length > 0 ? parts.join(" and ") : query;
  parsedQueryByShorthand.set(query, parsed);
  return parsed;
}

function getServerSnapshot(): boolean {
  return false;
}

/** The `useSyncExternalStore` pair for one media query. Both members are referentially stable. */
export interface MediaQueryStore {
  readonly subscribe: (onStoreChange: () => void) => () => void;
  readonly getSnapshot: () => boolean;
}

/**
 * Store used before there is a `window` (SSR, non-DOM test environments). Never cached against a
 * query, so the first browser render still builds a real store.
 */
const SERVER_MEDIA_QUERY_STORE: MediaQueryStore = {
  subscribe: () => () => {},
  getSnapshot: getServerSnapshot,
};

const storeByQuery = new Map<string, MediaQueryStore>();
/**
 * The `window` the cached stores' MediaQueryList objects belong to. If the global is swapped
 * (per-file DOM environments in tests), the cache is rebuilt rather than handing out listeners
 * attached to a dead window.
 */
let storeCacheOwner: unknown = null;

function createMediaQueryStore(mql: MediaQueryList): MediaQueryStore {
  const listeners = new Set<() => void>();
  // One native listener per query no matter how many components read it. Notifying is what
  // React re-renders on; the snapshot itself is always read straight off the MediaQueryList,
  // so a subscriber that mounts mid-change can never observe a stale cached value.
  const onChange = () => {
    for (const listener of listeners) listener();
  };

  return {
    subscribe: (onStoreChange: () => void) => {
      listeners.add(onStoreChange);
      if (listeners.size === 1) mql.addEventListener("change", onChange);
      return () => {
        listeners.delete(onStoreChange);
        if (listeners.size === 0) mql.removeEventListener("change", onChange);
      };
    },
    getSnapshot: () => mql.matches,
  };
}

/**
 * The shared store for a fully resolved media-query string (`"(max-width: 767px)"`, not the
 * `"max-md"` shorthand). Returns the same object for the same query for the lifetime of the
 * window, which is what keeps `useSyncExternalStore` from tearing down and re-adding its
 * listener on every render of every consumer.
 */
export function getMediaQueryStore(query: string): MediaQueryStore {
  if (typeof window === "undefined") return SERVER_MEDIA_QUERY_STORE;

  if (storeCacheOwner !== window) {
    storeByQuery.clear();
    storeCacheOwner = window;
  }

  const existing = storeByQuery.get(query);
  if (existing) return existing;

  const store = createMediaQueryStore(window.matchMedia(query));
  storeByQuery.set(query, store);
  return store;
}

export type MediaQueryInput = {
  min?: Breakpoint | number;
  max?: Breakpoint | number;
  /** Touch-like input (finger). Use "fine" for mouse/trackpad. */
  pointer?: "coarse" | "fine";
};

export function useMediaQuery(query: BreakpointQuery | MediaQueryInput | (string & {})): boolean {
  // Both arguments come from a per-query singleton, so re-rendering does not re-subscribe and
  // reading the snapshot does not allocate a MediaQueryList. `useMediaQuery` sits under
  // `useLayoutMode`, which the hottest components in the app call on every streaming update.
  const { subscribe, getSnapshot } = getMediaQueryStore(parseQuery(query));
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function useIsMobile(): boolean {
  return useMediaQuery("max-md");
}

/**
 * Touch-first input, independent of viewport width: true on phones and tablets,
 * false for mouse/trackpad. Use it for hit targets and hover affordances, not to
 * pick a layout (see `useLayoutMode`).
 */
export function useIsCoarsePointer(): boolean {
  return useMediaQuery({ pointer: "coarse" });
}
