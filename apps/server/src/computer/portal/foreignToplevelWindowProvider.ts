/**
 * Window enumeration through `zwlr_foreign_toplevel_manager_v1`.
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
import {
  COMPUTER_ID_MAX_LENGTH,
  COMPUTER_LABEL_MAX_LENGTH,
  COMPUTER_WINDOW_LIST_MAX_LENGTH,
  type ComputerWindow,
} from "@synara/contracts";

import { clampTextToLength } from "../utf8Truncation.ts";
import type { DesktopHelperTransport, DesktopHelperWindow } from "./desktopHelperClient.ts";
import type { PortalProviderId, PortalWindowProvider } from "./providers.ts";

/**
 * The taskbar-shaped toplevel, translated into the contract's window shape.
 *
 * Titles and app ids are clamped to the contract's bounds here for the same
 * reason `parseWindows` clamps them: they are compositor-relayed application
 * text, and one paragraph-long browser title failing schema encode would
 * silence every window list and state push for the rest of the session.
 */
function toComputerWindow(toplevel: DesktopHelperWindow): ComputerWindow {
  return {
    id: clampTextToLength(toplevel.id, COMPUTER_ID_MAX_LENGTH) as ComputerWindow["id"],
    title: clampTextToLength(toplevel.title, COMPUTER_LABEL_MAX_LENGTH),
    ...(toplevel.appId
      ? { appName: clampTextToLength(toplevel.appId, COMPUTER_LABEL_MAX_LENGTH) }
      : {}),
    // `focused` is the agent's input target and stays false until this backend
    // actually aims at the window; activation — which is what the protocol
    // carries, and what decides toolkit shortcut dispatch — rides on `active`,
    // matching the GNOME provider's convention. Conflating the two would make
    // every window claim to be where the agent is typing.
    focused: false,
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
    return toplevels.slice(0, COMPUTER_WINDOW_LIST_MAX_LENGTH).map(toComputerWindow);
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
