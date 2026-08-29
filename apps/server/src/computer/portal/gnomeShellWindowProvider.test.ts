/**
 * The GNOME Shell extension provider, against a fake extension.
 *
 * Nothing here opens a bus. What is worth pinning is the part that is Synara's
 * rather than GNOME's: the translation of the extension's document into windows
 * with real bounds, the ids staying addressable across calls, and — the reason
 * this provider exists at all — that every failure comes back as a sentence
 * naming the extension and its install path instead of an empty window list.
 */
import { describe, expect, it } from "vitest";

import { ComputerBackendError } from "../ComputerBackend.ts";
import {
  GNOME_EXTENSION_PROTOCOL_VERSION,
  GNOME_EXTENSION_SOURCE_PATH,
  GNOME_EXTENSION_UUID,
  GnomeShellWindowProvider,
  type GnomeShellComputerUseApi,
  type GnomeShellExtensionConnection,
} from "./gnomeShellWindowProvider.ts";

interface FakeExtensionOptions {
  readonly version?: unknown;
  /** The raw `ListWindows()` reply, JSON-encoded by the caller when it is one. */
  readonly windows?: unknown;
  readonly failVersion?: Error;
  readonly failListWindows?: Error;
  readonly failActivate?: Error;
  readonly failConnect?: Error;
}

interface FakeExtension {
  readonly calls: string[];
  connects: number;
  closes: number;
  readonly connect: () => Promise<GnomeShellExtensionConnection>;
}

/** A stand-in for the extension: records what was asked, answers what it was told to. */
function fakeExtension(options: FakeExtensionOptions = {}): FakeExtension {
  const state: FakeExtension = {
    calls: [],
    connects: 0,
    closes: 0,
    connect: () => {
      state.connects += 1;
      if (options.failConnect) return Promise.reject(options.failConnect);
      const api: GnomeShellComputerUseApi = {
        version: () => {
          state.calls.push("Version");
          if (options.failVersion) return Promise.reject(options.failVersion);
          return Promise.resolve(options.version ?? GNOME_EXTENSION_PROTOCOL_VERSION);
        },
        listWindows: () => {
          state.calls.push("ListWindows");
          if (options.failListWindows) return Promise.reject(options.failListWindows);
          return Promise.resolve(options.windows ?? JSON.stringify([]));
        },
        activateWindow: (windowId) => {
          state.calls.push(`ActivateWindow ${windowId}`);
          if (options.failActivate) return Promise.reject(options.failActivate);
          return Promise.resolve(undefined);
        },
        raiseWindow: (windowId) => {
          state.calls.push(`RaiseWindow ${windowId}`);
          return Promise.resolve(undefined);
        },
      };
      return Promise.resolve({
        api,
        close: () => {
          state.closes += 1;
          return Promise.resolve();
        },
      });
    },
  };
  return state;
}

/** One entry of the document the extension emits, in its own field names. */
function extensionWindow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "42",
    title: "Calculator",
    appId: "org.gnome.Calculator.desktop",
    resourceClass: "org.gnome.Calculator",
    pid: 4711,
    bounds: { x: 1280, y: 240, width: 400, height: 600 },
    visible: true,
    minimized: false,
    maximized: false,
    fullscreen: false,
    // No `focused`: the extension does not report one, because there is no
    // agent seat on GNOME to be focused. See the `focused` test below.
    active: true,
    windowType: "normal",
    monitor: 1,
    stackingIndex: 0,
    occludedBy: [],
    ...overrides,
  };
}

function providerFor(extension: FakeExtension, expectedProtocolVersion?: number) {
  return new GnomeShellWindowProvider({
    connect: extension.connect,
    ...(expectedProtocolVersion === undefined ? {} : { expectedProtocolVersion }),
  });
}

async function refusalFrom(action: Promise<unknown>): Promise<ComputerBackendError> {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(ComputerBackendError);
    return error as ComputerBackendError;
  }
  throw new Error("expected the provider to refuse, and it did not");
}

describe("GnomeShellWindowProvider", () => {
  it("declares the two capabilities that separate GNOME from wlroots", () => {
    const provider = providerFor(fakeExtension());
    // Both false on foreign-toplevel; both true here, which is what makes
    // window-scoped capture and window-relative targeting work on GNOME.
    expect(provider.providesBounds).toBe(true);
    expect(provider.providesStacking).toBe(true);
    expect(provider.id).toBe("gnome-shell-extension");
    expect(typeof provider.activateWindow).toBe("function");
    expect(typeof provider.raiseWindow).toBe("function");
  });

  it("translates the extension's document into windows that carry bounds", async () => {
    const extension = fakeExtension({
      windows: JSON.stringify([
        extensionWindow(),
        extensionWindow({
          id: "43",
          title: "Files",
          appId: "org.gnome.Nautilus.desktop",
          pid: 5122,
          bounds: { x: 1300, y: 260, width: 900, height: 700 },
          active: false,
          minimized: true,
          visible: false,
          stackingIndex: 1,
          occludedBy: ["42"],
        }),
      ]),
    });

    const windows = await providerFor(extension).listWindows();

    expect(windows).toEqual([
      {
        id: "42",
        title: "Calculator",
        appName: "org.gnome.Calculator.desktop",
        pid: 4711,
        bounds: { x: 1280, y: 240, width: 400, height: 600 },
        focused: false,
        active: true,
        minimized: false,
        visible: true,
        stackingIndex: 0,
      },
      {
        id: "43",
        title: "Files",
        appName: "org.gnome.Nautilus.desktop",
        pid: 5122,
        bounds: { x: 1300, y: 260, width: 900, height: 700 },
        focused: false,
        active: false,
        minimized: true,
        visible: false,
        stackingIndex: 1,
        occludedBy: ["42"],
      },
    ]);
  });

  it("never reports a window as focused, because GNOME has no agent seat to focus it", async () => {
    // `focused` means the agent seat's input target everywhere in this stack,
    // and ComputerManager's `agentFocusOnly` guard uses it to keep post-action
    // observation off the human's screen. mutter's has_focus() is the *human's*
    // keyboard focus, so an extension reporting it as `focused` would aim that
    // observation straight at whatever they are typing into. It is reported as
    // `active`, and `focused` is forced false even when the document carries it
    // — an older installed extension must not be able to reintroduce the leak.
    const extension = fakeExtension({
      windows: JSON.stringify([
        extensionWindow({ focused: true, active: true }),
        extensionWindow({ id: "43", stackingIndex: 1, focused: true, active: false }),
      ]),
    });

    const windows = await providerFor(extension).listWindows();

    expect(windows.map((window) => window.focused)).toEqual([false, false]);
    expect(windows.map((window) => window.active)).toEqual([true, false]);
  });

  it("keeps the extension's ids, so a window stays addressable as it changes", async () => {
    // The id is mutter's stable sequence. A window that is retitled, moved, and
    // pushed down the stack is the same window, and the id the agent captured
    // on the first list has to still work on the second.
    const extension = fakeExtension({ windows: JSON.stringify([extensionWindow()]) });
    const provider = providerFor(extension);

    const [first] = await provider.listWindows();
    expect(first?.id).toBe("42");

    await provider.activateWindow(first?.id ?? "");
    await provider.raiseWindow("42");

    expect(extension.calls).toEqual([
      "Version",
      "ListWindows",
      "ActivateWindow 42",
      "RaiseWindow 42",
    ]);
  });

  it("connects and verifies the protocol once, not per call", async () => {
    const extension = fakeExtension({ windows: JSON.stringify([extensionWindow()]) });
    const provider = providerFor(extension);

    await provider.listWindows();
    await provider.listWindows();

    expect(extension.connects).toBe(1);
    expect(extension.calls.filter((call) => call === "Version")).toHaveLength(1);
  });

  it("refuses by naming the extension and its install path when nothing answers", async () => {
    const extension = fakeExtension({
      failConnect: new Error("no such name org.synara.ComputerUse"),
    });

    const error = await refusalFrom(providerFor(extension).listWindows());

    expect(error.retryable).toBe(false);
    expect(error.message).toContain(GNOME_EXTENSION_UUID);
    expect(error.message).toContain(GNOME_EXTENSION_SOURCE_PATH);
    expect(error.message).toContain("gnome-extensions enable");
    // The two states that look identical from here, both named rather than guessed.
    expect(error.message).toContain("log out and back in");
    expect(error.message).toContain("locked");
  });

  it("retries the connection on the next call, because the extension can arrive later", async () => {
    // Installing the extension, or unlocking the screen, brings the bus name
    // back. A latched refusal would make the user restart the server for it.
    let failing = true;
    const extension = fakeExtension({ windows: JSON.stringify([extensionWindow()]) });
    const provider = new GnomeShellWindowProvider({
      connect: () => {
        if (failing) return Promise.reject(new Error("no such name"));
        return extension.connect();
      },
    });

    await refusalFrom(provider.listWindows());
    failing = false;

    expect(await provider.listWindows()).toHaveLength(1);
  });

  it("refuses with update-the-extension copy when the protocol version differs", async () => {
    const extension = fakeExtension({ version: 2 });

    const error = await refusalFrom(providerFor(extension, 1).listWindows());

    expect(error.retryable).toBe(false);
    expect(error.message).toContain("protocol version 2");
    expect(error.message).toContain("Update the extension");
    expect(error.message).toContain(GNOME_EXTENSION_SOURCE_PATH);
    // A newer extension than the server is the other side of the same gap, and
    // the fix is different, so it is said out loud.
    expect(error.message).toContain("newer than this server");
    // No window call was attempted against a protocol Synara cannot read.
    expect(extension.calls).toEqual(["Version"]);
    expect(extension.closes).toBe(1);
  });

  it("refuses when the version is not a number at all", async () => {
    const extension = fakeExtension({ version: "one" });

    const error = await refusalFrom(providerFor(extension).listWindows());

    expect(error.message).toContain("rather than a protocol version number");
    expect(error.message).toContain("Update the extension");
  });

  it("names the KWin plugin when something else owns the bus name", async () => {
    // The KWin plugin owns the same address and speaks a different API, so an
    // unanswered Version() on a host forced into Tier 2 has a specific cause.
    const extension = fakeExtension({
      failVersion: new Error("D-Bus method Version is unavailable."),
    });

    const error = await refusalFrom(providerFor(extension).listWindows());

    expect(error.message).toContain("did not answer");
    expect(error.message).toContain("KWin plugin");
    expect(extension.closes).toBe(1);
  });

  it("refuses rather than reporting an empty desktop when the document is unreadable", async () => {
    const cases: readonly [string, unknown][] = [
      ["not JSON", "{ this is not json"],
      ["not an array", JSON.stringify({ windows: [] })],
      ["not a string", 17],
    ];
    for (const [, payload] of cases) {
      const error = await refusalFrom(
        providerFor(fakeExtension({ windows: payload })).listWindows(),
      );
      expect(error.message).toContain("could not read");
      expect(error.message).toContain(GNOME_EXTENSION_SOURCE_PATH);
    }
  });

  it("refuses when every reported window is unusable, and reports an empty desktop as empty", async () => {
    // A window with no rect cannot be addressed, so `parseWindows` drops it.
    // Dropping all of them is a broken extension; an actually empty desktop is
    // an empty list, and the two must not look alike.
    const broken = await refusalFrom(
      providerFor(
        fakeExtension({ windows: JSON.stringify([{ id: "42", title: "no rect" }]) }),
      ).listWindows(),
    );
    expect(broken.message).toContain("none of which carried a usable id and rect");

    const empty = fakeExtension({ windows: JSON.stringify([]) });
    expect(await providerFor(empty).listWindows()).toEqual([]);
  });

  it("keeps the extension's own sentence when an operation fails", async () => {
    const extension = fakeExtension({
      windows: JSON.stringify([extensionWindow()]),
      failActivate: new Error('No window with id "42" exists on this desktop.'),
    });

    const error = await refusalFrom(providerFor(extension).activateWindow("42"));

    expect(error.retryable).toBe(false);
    expect(error.message).toContain("activate window");
    expect(error.message).toContain("No window with id");
  });

  it("reconnects after a failed operation instead of failing forever", async () => {
    // A disabled extension takes its connection with it; the proxy that is left
    // is dead, and every later call would fail against it.
    let failListWindows: Error | undefined = new Error("connection is closed");
    const state = { connects: 0, closes: 0 };
    const provider = new GnomeShellWindowProvider({
      connect: () => {
        state.connects += 1;
        return Promise.resolve({
          api: {
            version: () => Promise.resolve(GNOME_EXTENSION_PROTOCOL_VERSION),
            listWindows: () =>
              failListWindows
                ? Promise.reject(failListWindows)
                : Promise.resolve(JSON.stringify([extensionWindow()])),
            activateWindow: () => Promise.resolve(undefined),
            raiseWindow: () => Promise.resolve(undefined),
          },
          close: () => {
            state.closes += 1;
            return Promise.resolve();
          },
        });
      },
    });

    await refusalFrom(provider.listWindows());
    failListWindows = undefined;

    expect(await provider.listWindows()).toHaveLength(1);
    expect(state.connects).toBe(2);
  });

  it("closes the connection on dispose, and refuses afterwards", async () => {
    const extension = fakeExtension({ windows: JSON.stringify([extensionWindow()]) });
    const provider = providerFor(extension);
    await provider.listWindows();

    await provider.dispose();

    expect(extension.closes).toBe(1);
    const error = await refusalFrom(provider.listWindows());
    expect(error.message).toContain("disposed");
  });

  it("disposes cleanly when it was never used", async () => {
    const extension = fakeExtension();
    await providerFor(extension).dispose();
    expect(extension.connects).toBe(0);
  });
});
