import { describe, expect, it, vi } from "vitest";

import { AUTH_SIGNED_OUT_PATH, bootstrapSignedOutScreen } from "./authSignedOut";
import { readBootstrapLocation } from "./lib/bootstrapLocation";

describe("bootstrapSignedOutScreen", () => {
  it("renders only on the dedicated signed-out route", () => {
    const render = vi.fn();
    const at = (pathname: string, hash = "") =>
      bootstrapSignedOutScreen({
        location: readBootstrapLocation({ pathname, search: "", hash }),
        render,
      });

    expect(at("/")).toBe(false);
    expect(render).not.toHaveBeenCalled();

    expect(at(AUTH_SIGNED_OUT_PATH)).toBe(true);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("renders on the signed-out route under hash history", () => {
    const render = vi.fn();
    const at = (hash: string) =>
      bootstrapSignedOutScreen({
        location: readBootstrapLocation({ pathname: "/", search: "", hash }),
        render,
      });

    expect(at("#/")).toBe(false);
    expect(render).not.toHaveBeenCalled();

    expect(at(`#${AUTH_SIGNED_OUT_PATH}`)).toBe(true);
    expect(render).toHaveBeenCalledTimes(1);
  });
});
