/**
 * Input through `org.freedesktop.portal.RemoteDesktop`.
 *
 * This is the input path for every desktop with a portal and no unprivileged
 * virtual-device protocol, which in practice means GNOME. Unlike the wlroots
 * providers it costs the user a consent dialog, and unlike them it cannot be
 * created without one — that asymmetry is why the session is opened lazily on
 * the first action rather than at construction.
 *
 * Two things are worth knowing about the mechanism.
 *
 * **Keycodes, not keysyms.** `NotifyKeyboardKeycode` takes evdev keycodes, so
 * `evdevInput.ts` — the same table KWin and wlroots drive — is reused verbatim.
 * The portal also offers `NotifyKeyboardKeysym`, which would have meant a
 * second keymap for one desktop and a different answer for every layout.
 *
 * **Absolute motion needs a stream.** `NotifyPointerMotionAbsolute` addresses a
 * ScreenCast stream, not the desktop, which is why `PortalSession` joins a
 * ScreenCast session onto the same handle. That join is what makes this
 * provider able to click at a coordinate at all, and it is also why input works
 * here today while capture does not: the stream's *position and size* come back
 * in the `Start` response, whereas its *pixels* need PipeWire.
 *
 * `libei` is the mechanism the Tier 2 plan names for this slot and remains the
 * better one — it is a direct socket rather than a D-Bus round trip per event,
 * which matters for a 60-step glide. It needs native code, so this provider is
 * the path that works without it; `PortalSession.connectToEIS()` is already
 * wired for the day that lands.
 */
import type { ComputerInputSink } from "../pointerSequencing.ts";
import type { PortalSession } from "./portalSession.ts";
import type { PortalInputProvider, PortalProviderId } from "./providers.ts";

export class PortalRemoteDesktopInputProvider implements PortalInputProvider {
  readonly id: PortalProviderId = "portal-remote-desktop";
  /**
   * The portal grants a virtual device on the human's own seat — there is no
   * second pointer and no isolation, and the screen-sharing indicator stays lit
   * for as long as the grant lives.
   */
  readonly sharedSeat = true;
  readonly sink: ComputerInputSink;

  /**
   * What this provider currently holds down.
   *
   * The portal has no "release everything" call, and the seat belongs to the
   * human: a modifier left down by an interrupted hotkey is not a Synara bug
   * the user can see, it is a keyboard that has stopped working. Tracking is
   * the only way to put them back up, so it is tracked.
   */
  private readonly heldKeys = new Set<number>();
  private readonly heldButtons = new Set<number>();

  constructor(
    private readonly session: PortalSession,
    /** Releases this provider's share of the session. See `sharePortalSession`. */
    private readonly release: () => Promise<void>,
  ) {
    // `operation` is the sequencer's own label for a step and has no place on
    // the wire, so it is dropped here rather than invented into an option.
    this.sink = {
      movePointer: (x, y) => this.session.movePointerTo({ x, y }),
      button: async (code, pressed) => {
        await this.session.pointerButton(code, pressed);
        track(this.heldButtons, code, pressed);
      },
      key: async (code, pressed) => {
        await this.session.key(code, pressed);
        track(this.heldKeys, code, pressed);
      },
    };
  }

  scroll(deltaX: number, deltaY: number): Promise<void> {
    return this.session.scroll(deltaX, deltaY);
  }

  /**
   * No `pointerPosition`: the portal is write-only. It will move the pointer
   * and will not say where it ended up, so the backend's cached position is the
   * only answer there is — which is what omitting this method tells it.
   */

  async dispose(): Promise<void> {
    // The session may outlive this provider — the clipboard shares it — so the
    // seat is not cleared by the teardown that would otherwise clear it.
    // Failures are swallowed: a session that is already gone has released
    // everything anyway, and throwing here would abort the rest of disposal.
    for (const code of this.heldButtons) {
      await this.session.pointerButton(code, false).catch(() => undefined);
    }
    for (const code of this.heldKeys) {
      await this.session.key(code, false).catch(() => undefined);
    }
    this.heldButtons.clear();
    this.heldKeys.clear();
    await this.release();
  }
}

function track(held: Set<number>, code: number, pressed: boolean): void {
  if (pressed) held.add(code);
  else held.delete(code);
}
