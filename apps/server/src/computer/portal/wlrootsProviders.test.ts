/**
 * The wlroots providers and the helper sharing that keeps them to one Wayland
 * connection.
 *
 * The providers are deliberately thin — the compositor work is in C — so what
 * is worth testing here is the translation and the lifetime: which helper call
 * a request becomes, how an answer becomes a `ComputerWindow` or a capture
 * region, and that three provider slots over one process spawn one process and
 * dispose it once.
 */
import { describe, expect, it } from "vitest";

import type { ClipboardCommandSpec } from "../wlClipboard.ts";
import { fakeDesktopHelper, fakePng } from "./fakeDesktopHelper.ts";
import { ForeignToplevelWindowProvider } from "./foreignToplevelWindowProvider.ts";
import type { PortalProbe, PortalProviderPlan } from "./probe.ts";
import type { PortalInputProvider, PortalWindowProvider, ProviderSlot } from "./providers.ts";
import { WlClipboardProvider } from "./wlClipboardProvider.ts";
import { resolveWlrootsProviders } from "./wlrootsProviders.ts";
import { WlrootsInputProvider } from "./wlrootsInputProvider.ts";
import { WlrScreencopyProvider } from "./wlrScreencopyProvider.ts";

const noRelease = () => Promise.resolve();

/** What resolved, or `undefined` for a slot this desktop cannot fill. */
function slotProvider<T>(slot: ProviderSlot<T> | undefined): T | undefined {
  return slot?.available === true ? slot.provider : undefined;
}

describe("WlrootsInputProvider", () => {
  it("forwards the sequencer's sink calls to the helper unchanged", async () => {
    const helper = fakeDesktopHelper();
    const provider = new WlrootsInputProvider(helper, noRelease);

    await provider.sink.movePointer(120, 340, "move to the button");
    await provider.sink.button(0x110, true, "press");
    await provider.sink.button(0x110, false, "release");
    await provider.sink.key(29, true, "hold ctrl");
    await provider.scroll(0, -3);

    expect(helper.calls).toEqual([
      "pointerMotion 120,340",
      "pointerButton 272,true",
      "pointerButton 272,false",
      "key 29,true",
      "scroll 0,-3",
    ]);
  });

  it("declares the shared seat, because a virtual device joins the human's", () => {
    expect(new WlrootsInputProvider(fakeDesktopHelper(), noRelease).sharedSeat).toBe(true);
  });

  it("cannot read the pointer position, and says so by not offering the method", () => {
    // A Wayland client has no way to ask where the cursor is; the backend falls
    // back to its own cached position when this method is absent.
    const input: PortalInputProvider = new WlrootsInputProvider(fakeDesktopHelper(), noRelease);
    expect(input.pointerPosition).toBeUndefined();
  });

  it("releases held input before releasing its share of the helper", async () => {
    // Order matters: the release has to reach a live helper. Reversed, a last
    // release would dispose the process and strand a held modifier for the
    // human — on the seat they are actively using.
    const helper = fakeDesktopHelper();
    let releasedAfter: readonly string[] = [];
    const provider = new WlrootsInputProvider(helper, () => {
      releasedAfter = [...helper.calls];
      return Promise.resolve();
    });

    await provider.dispose();

    expect(releasedAfter).toEqual(["releaseAll"]);
  });
});

describe("WlrScreencopyProvider", () => {
  it("reads the workspace rect live, so a hotplugged monitor is not missed", async () => {
    const helper = fakeDesktopHelper({
      outputs: {
        outputs: [
          { name: "DP-1", rect: { x: 0, y: 0, width: 2560, height: 1440 }, scale: 1 },
          { name: "DP-2", rect: { x: 2560, y: 0, width: 1920, height: 1080 }, scale: 1 },
        ],
        workspace: { x: 0, y: 0, width: 4480, height: 1440 },
      },
    });
    const provider = new WlrScreencopyProvider(helper, noRelease);

    await expect(provider.workspaceRect()).resolves.toEqual({
      x: 0,
      y: 0,
      width: 4480,
      height: 1440,
    });
    await expect(provider.workspaceRect()).resolves.toBeDefined();
    // Twice, not cached once: the coordinate space every click is expressed in
    // changes the moment a monitor is plugged in or rearranged.
    expect(helper.calls).toEqual(["outputs", "outputs"]);
  });

  it("returns the region the helper covered, not the one that was requested", async () => {
    // The pixel-to-desktop mapping the caller scales clicks with comes from
    // this rect, so a request clipped at the edge of the desktop must come back
    // clipped, not as asked.
    const covered = { x: 0, y: 0, width: 1920, height: 1080 };
    const helper = fakeDesktopHelper({
      capture: () => ({ bytes: fakePng(960, 540), region: covered }),
    });
    const provider = new WlrScreencopyProvider(helper, noRelease);

    const image = await provider.captureRegion({ x: -40, y: 0, width: 4000, height: 3000 }, 960);

    expect(image.region).toEqual(covered);
    expect(image.bytes.byteLength).toBeGreaterThan(0);
    expect(helper.calls).toEqual(["capture -40,0,4000,3000 max=960"]);
  });

  it("passes the refusal through when the compositor has no screencopy", async () => {
    const helper = fakeDesktopHelper({ failWith: "no zwlr_screencopy_manager_v1 here" });
    const provider = new WlrScreencopyProvider(helper, noRelease);

    await expect(provider.captureRegion({ x: 0, y: 0, width: 8, height: 8 }, 8)).rejects.toThrow(
      /no zwlr_screencopy_manager_v1 here/,
    );
  });
});

describe("ForeignToplevelWindowProvider", () => {
  it("maps toplevels to windows with no bounds, because the protocol has none", async () => {
    const helper = fakeDesktopHelper({
      windows: [
        {
          id: "toplevel-1",
          title: "README.md — Text Editor",
          appId: "org.gnome.TextEditor",
          activated: true,
          minimized: false,
          maximized: true,
          fullscreen: false,
        },
        {
          id: "toplevel-2",
          title: "Terminal",
          appId: "",
          activated: false,
          minimized: true,
          maximized: false,
          fullscreen: false,
        },
      ],
    });
    const provider = new ForeignToplevelWindowProvider(helper, noRelease);

    const windows = await provider.listWindows();

    expect(windows).toEqual([
      {
        id: "toplevel-1",
        title: "README.md — Text Editor",
        appName: "org.gnome.TextEditor",
        focused: true,
        active: true,
        minimized: false,
        visible: true,
      },
      // No `appName` at all rather than an empty one: a blank app id is the
      // compositor saying it does not know, and "" would render as a name.
      {
        id: "toplevel-2",
        title: "Terminal",
        focused: false,
        active: false,
        minimized: true,
        visible: false,
      },
    ]);
    for (const window of windows) expect(window.bounds).toBeUndefined();
  });

  it("declares that it knows neither geometry nor stacking", () => {
    // Both flags gate refusals further up. Claiming either would turn a
    // "cannot know" into a window placed at the origin.
    const provider = new ForeignToplevelWindowProvider(fakeDesktopHelper(), noRelease);
    expect(provider.providesBounds).toBe(false);
    expect(provider.providesStacking).toBe(false);
  });

  it("activates by id and offers no raise, which would silently steal focus", async () => {
    const helper = fakeDesktopHelper();
    const windows: PortalWindowProvider = new ForeignToplevelWindowProvider(helper, noRelease);

    await windows.activateWindow?.("toplevel-1");

    expect(helper.calls).toEqual(["activateWindow toplevel-1"]);
    expect(windows.raiseWindow).toBeUndefined();
  });

  it("propagates a refusal instead of reporting an empty desktop", async () => {
    const helper = fakeDesktopHelper({ failWith: "no zwlr_foreign_toplevel_management_v1 here" });
    const provider = new ForeignToplevelWindowProvider(helper, noRelease);

    await expect(provider.listWindows()).rejects.toThrow(/foreign_toplevel/);
  });
});

describe("WlClipboardProvider", () => {
  it("drives wl-paste and wl-copy through the shared Tier 1 helpers", async () => {
    const specs: ClipboardCommandSpec[] = [];
    const provider = new WlClipboardProvider((spec) => {
      specs.push(spec);
      return Promise.resolve({ outcome: "exited", code: 0, stdout: "copied text", stderr: "" });
    });

    await expect(provider.read()).resolves.toBe("copied text");
    await provider.write("written text");

    expect(specs.map((spec) => spec.command)).toEqual(["wl-paste", "wl-copy"]);
    // Through stdin, never argv: clipboard text must not land in /proc cmdline.
    expect(specs[1]?.input).toBe("written text");
  });
});

/** The plan a wlroots desktop with every global produces, minus any overrides. */
function plan(overrides: Partial<PortalProviderPlan> = {}): PortalProviderPlan {
  return {
    input: { implementation: "wlroots-virtual-input" },
    capture: { implementation: "wlr-screencopy" },
    windows: { implementation: "wlr-foreign-toplevel" },
    clipboard: { implementation: "wl-clipboard" },
    ...overrides,
  };
}

describe("resolveWlrootsProviders", () => {
  const probe = (helperBinary: string | undefined): PortalProbe =>
    ({
      sessionType: "wayland",
      desktop: "wlroots",
      kwinPresent: false,
      sessionBusReachable: true,
      portal: { present: false },
      desktopExtensionPresent: false,
      wlClipboard: true,
      gaps: [],
      ...(helperBinary === undefined ? {} : { helperBinary }),
    }) as PortalProbe;

  it("builds one helper for the three Wayland-native slots", () => {
    let helpers = 0;
    const resolved = resolveWlrootsProviders(probe("/opt/helper"), plan(), {
      createHelper: () => {
        helpers += 1;
        return fakeDesktopHelper();
      },
      createClipboard: () => new WlClipboardProvider(() => Promise.reject(new Error("unused"))),
    });

    // One connection, or the compositor would hand out a second set of virtual
    // devices and disagree with itself about which keys are held.
    expect(helpers).toBe(1);
    expect(slotProvider(resolved.input)?.id).toBe("wlroots-virtual-input");
    expect(slotProvider(resolved.capture)?.id).toBe("wlr-screencopy");
    expect(slotProvider(resolved.windows)?.id).toBe("wlr-foreign-toplevel");
    expect(slotProvider(resolved.clipboard)?.id).toBe("wl-clipboard");
  });

  it("disposes the helper only after the last slot that shares it", async () => {
    const helper = fakeDesktopHelper();
    const resolved = resolveWlrootsProviders(probe("/opt/helper"), plan(), {
      createHelper: () => helper,
    });

    await slotProvider(resolved.input)?.dispose();
    await slotProvider(resolved.capture)?.dispose();
    expect(helper.calls).not.toContain("dispose");

    await slotProvider(resolved.windows)?.dispose();
    expect(helper.calls.filter((call) => call === "dispose")).toEqual(["dispose"]);
  });

  it("spawns no helper when every slot it would serve is blocked", () => {
    let helpers = 0;
    const blocked = { blockedBy: "this compositor advertises no wlroots protocols" };
    const resolved = resolveWlrootsProviders(
      probe("/opt/helper"),
      plan({ input: blocked, capture: blocked, windows: blocked }),
      {
        createHelper: () => {
          helpers += 1;
          return fakeDesktopHelper();
        },
      },
    );

    expect(helpers).toBe(0);
    expect(resolved.input).toBeUndefined();
    expect(resolved.capture).toBeUndefined();
    expect(resolved.windows).toBeUndefined();
    // The clipboard is its own short-lived processes, so it survives a desktop
    // where every Wayland-native slot refused.
    expect(slotProvider(resolved.clipboard)?.id).toBe("wl-clipboard");
  });

  it("builds nothing helper-backed when the helper is not built", () => {
    const resolved = resolveWlrootsProviders(probe(undefined), plan(), {
      createHelper: () => {
        throw new Error("the helper must not be constructed without a binary");
      },
    });

    expect(resolved.input).toBeUndefined();
    expect(resolved.capture).toBeUndefined();
    expect(resolved.windows).toBeUndefined();
    expect(resolved.clipboard).toBeDefined();
  });

  it("shares the helper between only the slots that are usable", async () => {
    const helper = fakeDesktopHelper();
    const resolved = resolveWlrootsProviders(
      probe("/opt/helper"),
      plan({ windows: { blockedBy: "no foreign-toplevel protocol here" } }),
      { createHelper: () => helper },
    );

    expect(resolved.windows).toBeUndefined();
    await slotProvider(resolved.input)?.dispose();
    expect(helper.calls).not.toContain("dispose");
    // Two users, not three: a share count taken from the plan rather than the
    // slot list would leave the process alive with nobody holding it.
    await slotProvider(resolved.capture)?.dispose();
    expect(helper.calls).toContain("dispose");
  });
});
