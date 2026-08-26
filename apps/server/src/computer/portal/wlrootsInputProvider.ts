/**
 * Input through wlroots' unprivileged virtual-device protocols.
 *
 * `zwlr_virtual_pointer_v1` and `zwp_virtual_keyboard_v1` need no portal and no
 * consent dialog: a compositor that advertises them hands any client on the
 * session a synthetic device. That is why this is the preferred Tier 2 input
 * provider wherever it exists — it is the only one that can be created without
 * putting a dialog on the user's screen.
 *
 * The devices attach to the seat the human is already using, so there is no
 * second cursor and no isolation: a click lands wherever the pointer is, and
 * the human sees it move. `sharedSeat` is true, which is what the panel's
 * shared-control warning reads.
 *
 * Everything above the wire — eased glides, shift bookkeeping, hotkey release
 * order — is `pointerSequencing.ts` driving this `ComputerInputSink`, the same
 * one the KWin backend drives. This class only forwards.
 */
import type { ComputerInputSink } from "../pointerSequencing.ts";
import type { DesktopHelperTransport } from "./desktopHelperClient.ts";
import type { PortalInputProvider, PortalProviderId } from "./providers.ts";

export class WlrootsInputProvider implements PortalInputProvider {
  readonly id: PortalProviderId = "wlroots-virtual-input";
  /** A virtual device joins the existing seat; wlroots offers no way to make another. */
  readonly sharedSeat = true;
  readonly sink: ComputerInputSink;

  constructor(
    private readonly helper: DesktopHelperTransport,
    /** Releases this provider's share of the helper. See `shareDesktopHelper`. */
    private readonly release: () => Promise<void>,
  ) {
    // `operation` is the sequencer's label for the step, used in its own
    // failures; the wire carries no such field, so it is dropped here.
    this.sink = {
      movePointer: (x, y) => this.helper.pointerMotion(x, y),
      button: (code, pressed) => this.helper.pointerButton(code, pressed),
      key: (code, pressed) => this.helper.key(code, pressed),
    };
  }

  /**
   * A wheel event, not a pointer move. Both the discrete step count and the
   * pixel delta go out together because a toolkit reads one or the other, and
   * sending only one makes it either ignore the scroll or jump a whole page.
   */
  scroll(deltaX: number, deltaY: number): Promise<void> {
    return this.helper.scroll(deltaX, deltaY);
  }

  /**
   * No `pointerPosition`: a Wayland client cannot ask where the pointer is, and
   * a virtual pointer has no readback. The backend's cached position is the
   * only answer available, which is what omitting this method tells it.
   */

  async dispose(): Promise<void> {
    // Anything still held goes down with the connection anyway — the compositor
    // releases a virtual device's keys when its client disconnects — but the
    // release is explicit so a shared helper that outlives this provider does
    // not leave a modifier stuck for the human.
    await this.helper.releaseAll();
    await this.release();
  }
}
