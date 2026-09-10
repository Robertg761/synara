import { describe, expect, it } from "vitest";
import {
  consumeMobilePairingIntent,
  parseMobilePairingIntent,
  receiveMobilePairingIntent,
  subscribeMobilePairingIntent,
} from "./mobilePairingIntent";

describe("mobile pairing intents", () => {
  it("accepts the native pairing link without putting credentials in a route", () => {
    expect(parseMobilePairingIntent(
      "synara://pair?server=https%3A%2F%2Fbox.example%3A8443&token=one-use",
    )).toEqual({ serverUrl: "https://box.example:8443", credential: "one-use" });
  });

  it("rejects foreign entry points and unsafe server URLs", () => {
    for (const url of [
      "https://pair?server=https://box.example&token=secret",
      "synara://other?server=https://box.example&token=secret",
      "synara://pair?server=http://box.example&token=secret",
      "synara://pair?server=https://user:pass@box.example&token=secret",
      "synara://pair?server=https://box.example/path&token=secret",
      "synara://pair?server=https://box.example",
      "not a url",
    ]) expect(parseMobilePairingIntent(url)).toBeNull();
  });

  it("delivers to a mounted screen and consumes a cold-start intent once", () => {
    let calls = 0;
    const stop = subscribeMobilePairingIntent(() => { calls++; });
    const intent = { serverUrl: "https://box.example", credential: "secret" };
    receiveMobilePairingIntent(intent);
    expect(calls).toBe(1);
    expect(consumeMobilePairingIntent()).toEqual(intent);
    expect(consumeMobilePairingIntent()).toBeNull();
    stop();
    receiveMobilePairingIntent(intent);
    expect(calls).toBe(1);
    consumeMobilePairingIntent();
  });
});
