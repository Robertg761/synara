/**
 * Window enumeration through `zwlr_foreign_toplevel_management_v1`.
 *
 * This protocol exists for taskbars, and it reports what a taskbar needs: a
 * title, an app id, and the activated/minimized/maximized/fullscreen state. It
 * reports **no geometry at all** — there is no request for a toplevel's
 * position or size, and no Wayland client can ask the compositor where a window
 * is. That is not an omission this provider can work around, so
 * `providesBounds` is false and every window arrives without `bounds`, which is
 * the case `ComputerWindow.bounds` was made optional for.
 *
 * The consequence reaches the agent: window-scoped capture and window-relative
 * targeting refuse on this desktop (see `requireWindowBounds`), and the working
 * pattern is full-screen capture plus desktop coordinates. Refusing is the
 * point — reporting a window at the origin, or an empty list, is the failure
 * mode that had an agent relaunching the same app until its turn ended.
 */
import type { ComputerWindow } from "@synara/contracts";

import type { DesktopHelperTransport, DesktopHelperWindow } from "./desktopHelperClient.ts";
import type { PortalProviderId, PortalWindowProvider } from "./providers.ts";

/** The taskbar-shaped toplevel, translated into the contract's window shape. */
function toComputerWindow(toplevel: DesktopHelperWindow): ComputerWindow {
  return {
    id: toplevel.id as ComputerWindow["id"],
    title: toplevel.title,
    ...(toplevel.appId ? { appName: toplevel.appId } : {}),
    // Activation is the only focus signal the protocol carries, and it is the
    // one that matters for input: a toolkit dispatches keyboard shortcuts only
    // to the activated window.
    focused: toplevel.activated,
    active: toplevel.activated,
    minimized: toplevel.minimized,
    // "Not minimized" is the strongest visibility claim available. Occlusion is
    // unknowable here for the same reason bounds are.
    visible: !toplevel.minimized,
  };
}

export class ForeignToplevelWindowProvider implements PortalWindowProvider {
  readonly id: PortalProviderId = "wlr-foreign-toplevel";
  /** The protocol has no geometry requests. Not a gap in this provider. */
  readonly providesBounds = false;
  /**
   * Toplevels arrive in the order the compositor announced them, which is
   * creation order, not stacking order. Reporting that as a stacking index
   * would make occlusion look knowable when it is not.
   */
  readonly providesStacking = false;

  constructor(
    private readonly helper: DesktopHelperTransport,
    private readonly release: () => Promise<void>,
  ) {}

  async listWindows(): Promise<readonly ComputerWindow[]> {
    const toplevels = await this.helper.listWindows();
    return toplevels.map(toComputerWindow);
  }

  /**
   * Activation moves the human's keyboard focus too — this is the shared seat,
   * and the protocol has no way to raise a window without focusing it. The
   * backend's refusal message for `raiseWindow` says so, which is why
   * `raiseWindow` is deliberately absent rather than aliased to this.
   */
  activateWindow(windowId: string): Promise<void> {
    return this.helper.activateWindow(windowId);
  }

  dispose(): Promise<void> {
    return this.release();
  }
}
