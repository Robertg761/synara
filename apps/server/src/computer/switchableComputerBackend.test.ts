import { describe, expect, it } from "vitest";

import type { ComputerBackendEvent } from "./ComputerBackend.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";
import { CheckingComputerBackend, SwitchableComputerBackend } from "./switchableComputerBackend.ts";

describe("SwitchableComputerBackend", () => {
  it("reads every member, including optional ones, from the current occupant", async () => {
    const slot = new SwitchableComputerBackend(new CheckingComputerBackend("Detecting."));
    // The placeholder has no clipboard; presence checks must see that.
    expect(slot.backend.readClipboard).toBeUndefined();
    expect("readClipboard" in slot.backend).toBe(false);
    expect(await slot.backend.probeAvailability()).toEqual({
      kind: "checking",
      message: "Detecting.",
    });

    const fake = new FakeComputerBackend();
    await slot.swap(fake);
    expect(slot.backend.readClipboard).toBeTypeOf("function");
    expect(slot.backend).toBeInstanceOf(FakeComputerBackend);
    await slot.backend.writeClipboard!("hello");
    expect(await fake.readClipboard()).toBe("hello");
  });

  it("carries event listeners and an attached preview stream across a swap", async () => {
    const first = new FakeComputerBackend();
    const second = new FakeComputerBackend();
    const slot = new SwitchableComputerBackend(first);
    const events: ComputerBackendEvent["type"][] = [];
    slot.backend.onEvent!((event) => events.push(event.type));
    const frames: number[] = [];
    await slot.backend.attachStream((frame) => frames.push(frame.sequence));

    await slot.swap(second, { desktopChanged: true });
    expect(first.callsFor("detachStream")).toHaveLength(1);
    expect(second.callsFor("attachStream")).toHaveLength(1);
    expect(events).toEqual([
      "desktop-interrupted",
      "windows-changed",
      "capabilities-changed",
      "health-changed",
    ]);

    // The replaced occupant no longer reaches the manager.
    events.length = 0;
    first.emitDesktopInterrupted();
    second.emitDesktopInterrupted();
    expect(events).toEqual(["desktop-interrupted"]);
  });

  it("reports a gone desktop to the service and still forwards the event", () => {
    const occupant = new FakeComputerBackend();
    const gone: string[] = [];
    const slot = new SwitchableComputerBackend(occupant, {
      onDesktopGone: (_backend, message) => gone.push(message),
    });
    const events: string[] = [];
    slot.backend.onEvent!((event) => events.push(event.type));
    occupant.emitDesktopGone("Instance exited.");
    expect(gone).toEqual(["Instance exited."]);
    expect(events).toEqual(["desktop-gone"]);
  });
});
