// FILE: mobileBackStack.test.ts
// Purpose: Covers back-press routing across dismissable surfaces, history, and app exit.
// Layer: Lib unit tests
// Depends on: mobileBackStack registry and Vitest assertions.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  handleMobileBack,
  registerBackDismissable,
  resetMobileBackStackForTests,
} from "./mobileBackStack";

function navigation(canGoBack: boolean) {
  return {
    canGoBack: () => canGoBack,
    goBack: vi.fn(),
  };
}

beforeEach(() => {
  resetMobileBackStackForTests();
});

describe("handleMobileBack", () => {
  it("dismisses the most recently registered surface first", () => {
    const order: string[] = [];
    registerBackDismissable(() => {
      order.push("first");
      return true;
    });
    registerBackDismissable(() => {
      order.push("second");
      return true;
    });

    const nav = navigation(true);
    expect(handleMobileBack(nav)).toBe("dismissed");
    expect(order).toEqual(["second"]);
    expect(nav.goBack).not.toHaveBeenCalled();
  });

  it("skips handlers that decline without unregistering them", () => {
    let declines = true;
    const sometimes = vi.fn(() => !declines);
    const bottom = vi.fn(() => true);
    registerBackDismissable(bottom);
    registerBackDismissable(sometimes);

    expect(handleMobileBack(navigation(true))).toBe("dismissed");
    expect(sometimes).toHaveBeenCalledTimes(1);
    expect(bottom).toHaveBeenCalledTimes(1);

    declines = false;
    expect(handleMobileBack(navigation(true))).toBe("dismissed");
    expect(sometimes).toHaveBeenCalledTimes(2);
    expect(bottom).toHaveBeenCalledTimes(1);
  });

  it("stops calling handlers once one consumes the press", () => {
    const lower = vi.fn(() => true);
    const upper = vi.fn(() => true);
    registerBackDismissable(lower);
    registerBackDismissable(upper);

    handleMobileBack(navigation(false));

    expect(upper).toHaveBeenCalledTimes(1);
    expect(lower).not.toHaveBeenCalled();
  });

  it("falls back to history when nothing is dismissable", () => {
    const declined = vi.fn(() => false);
    registerBackDismissable(declined);

    const nav = navigation(true);
    expect(handleMobileBack(nav)).toBe("navigated");
    expect(declined).toHaveBeenCalledTimes(1);
    expect(nav.goBack).toHaveBeenCalledTimes(1);
  });

  it("reports exit at the root of history", () => {
    const nav = navigation(false);
    expect(handleMobileBack(nav)).toBe("exit");
    expect(nav.goBack).not.toHaveBeenCalled();
  });
});

describe("registerBackDismissable", () => {
  it("stops routing back presses to unregistered surfaces", () => {
    const dismiss = vi.fn(() => true);
    const unregister = registerBackDismissable(dismiss);

    unregister();

    expect(handleMobileBack(navigation(false))).toBe("exit");
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("is safe to unregister twice and keeps other registrations intact", () => {
    const first = vi.fn(() => true);
    const unregisterFirst = registerBackDismissable(first);
    const second = vi.fn(() => true);
    registerBackDismissable(second);

    unregisterFirst();
    unregisterFirst();

    expect(handleMobileBack(navigation(false))).toBe("dismissed");
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("removes only one registration when the same callback registers twice", () => {
    const dismiss = vi.fn(() => true);
    const unregisterOuter = registerBackDismissable(dismiss);
    registerBackDismissable(dismiss);

    unregisterOuter();

    expect(handleMobileBack(navigation(false))).toBe("dismissed");
    expect(dismiss).toHaveBeenCalledTimes(1);

    expect(handleMobileBack(navigation(false))).toBe("dismissed");
    expect(dismiss).toHaveBeenCalledTimes(2);
  });
});
