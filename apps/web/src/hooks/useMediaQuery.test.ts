// FILE: useMediaQuery.test.ts
// Purpose: Locks the shared per-query media-query store — one MediaQueryList and one native
//          listener per query, referentially stable subscribe/getSnapshot (so re-rendering a
//          consumer never re-subscribes), and the no-window fallback.
// Layer: Web hook tests

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getMediaQueryStore, useIsMobile, useMediaQuery } from "./useMediaQuery";

interface FakeMediaQueryList {
  matches: boolean;
  readonly media: string;
  readonly addEventListener: ReturnType<typeof vi.fn>;
  readonly removeEventListener: ReturnType<typeof vi.fn>;
  emitChange: () => void;
}

function installFakeWindow(): {
  matchMedia: ReturnType<typeof vi.fn>;
  lists: FakeMediaQueryList[];
} {
  const lists: FakeMediaQueryList[] = [];
  const matchMedia = vi.fn((media: string) => {
    const handlers = new Set<() => void>();
    const list: FakeMediaQueryList = {
      matches: false,
      media,
      addEventListener: vi.fn((_type: string, handler: () => void) => {
        handlers.add(handler);
      }),
      removeEventListener: vi.fn((_type: string, handler: () => void) => {
        handlers.delete(handler);
      }),
      emitChange: () => {
        for (const handler of handlers) handler();
      },
    };
    lists.push(list);
    return list;
  });

  // A fresh object each time, so the store cache notices the window changed and rebuilds.
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { matchMedia },
    writable: true,
  });
  return { matchMedia, lists };
}

function uninstallFakeWindow(): void {
  Reflect.deleteProperty(globalThis, "window");
}

afterEach(() => {
  uninstallFakeWindow();
});

describe("getMediaQueryStore", () => {
  it("returns one stable store, MediaQueryList and listener per query", () => {
    const { matchMedia, lists } = installFakeWindow();

    const first = getMediaQueryStore("(max-width: 767px)");
    const second = getMediaQueryStore("(max-width: 767px)");

    expect(second).toBe(first);
    expect(second.subscribe).toBe(first.subscribe);
    expect(second.getSnapshot).toBe(first.getSnapshot);
    expect(matchMedia).toHaveBeenCalledTimes(1);

    // Two consumers (or one consumer re-subscribing) share the single native listener.
    const unsubscribeA = first.subscribe(() => {});
    const unsubscribeB = first.subscribe(() => {});
    expect(lists[0]!.addEventListener).toHaveBeenCalledTimes(1);

    unsubscribeA();
    expect(lists[0]!.removeEventListener).not.toHaveBeenCalled();
    unsubscribeB();
    expect(lists[0]!.removeEventListener).toHaveBeenCalledTimes(1);

    // Still no extra MediaQueryList: reading the snapshot must not allocate one.
    expect(first.getSnapshot()).toBe(false);
    lists[0]!.matches = true;
    expect(first.getSnapshot()).toBe(true);
    expect(matchMedia).toHaveBeenCalledTimes(1);
  });

  it("keeps distinct queries in distinct stores and notifies every subscriber", () => {
    const { matchMedia, lists } = installFakeWindow();

    const phone = getMediaQueryStore("(max-width: 767px)");
    const coarse = getMediaQueryStore("(pointer: coarse)");
    expect(coarse).not.toBe(phone);
    expect(matchMedia).toHaveBeenCalledTimes(2);

    const notified: string[] = [];
    phone.subscribe(() => notified.push("a"));
    phone.subscribe(() => notified.push("b"));
    coarse.subscribe(() => notified.push("coarse"));

    lists[0]!.emitChange();
    expect(notified).toEqual(["a", "b"]);
  });

  it("rebuilds the cache when the window itself is replaced", () => {
    const firstWindow = installFakeWindow();
    const firstStore = getMediaQueryStore("(max-width: 767px)");
    expect(firstWindow.matchMedia).toHaveBeenCalledTimes(1);

    const secondWindow = installFakeWindow();
    const secondStore = getMediaQueryStore("(max-width: 767px)");

    expect(secondStore).not.toBe(firstStore);
    expect(secondWindow.matchMedia).toHaveBeenCalledTimes(1);
  });

  it("falls back to a matches:false no-op store without a window", () => {
    const store = getMediaQueryStore("(max-width: 767px)");
    expect(store.getSnapshot()).toBe(false);
    // Subscribing is inert rather than throwing, and unsubscribing is safe.
    expect(() => store.subscribe(() => {})()).not.toThrow();
  });
});

describe("useMediaQuery", () => {
  it("resolves breakpoint shorthands once and reuses the shared store across renders", () => {
    const { matchMedia } = installFakeWindow();

    function Probe(): null {
      useIsMobile();
      useMediaQuery("max-md");
      useMediaQuery({ pointer: "coarse" });
      return null;
    }

    renderToStaticMarkup(createElement(Probe));
    renderToStaticMarkup(createElement(Probe));

    // Three hook calls across two renders resolve to only two distinct queries, and each one
    // built its MediaQueryList exactly once.
    expect(matchMedia.mock.calls.map(([media]) => media)).toEqual([
      "(max-width: 767px)",
      "(pointer: coarse)",
    ]);
  });
});
