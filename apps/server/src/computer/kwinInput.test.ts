import { describe, expect, it } from "vitest";

import { EVDEV_KEY_CODES, keyStrokeForKey } from "./kwinInput.ts";

describe("keyStrokeForKey", () => {
  it("maps literal and named space keys", () => {
    expect(keyStrokeForKey(" ")).toEqual({ code: EVDEV_KEY_CODES.Space, shift: false });
    expect(keyStrokeForKey("space")).toEqual({ code: EVDEV_KEY_CODES.Space, shift: false });
    expect(keyStrokeForKey("spacebar")).toEqual({ code: EVDEV_KEY_CODES.Space, shift: false });
  });

  it("keeps function keys on the named-key path", () => {
    expect(keyStrokeForKey("F12")).toEqual({ code: EVDEV_KEY_CODES.F12, shift: false });
  });
});
