/**
 * The pixel↔notch boundary for backends whose wheel speaks whole notches.
 *
 * Everything above the backends — the tool surface, the pane, every `scroll`
 * call — speaks logical pixels. KWin takes pixels directly and converts at the
 * last moment (value120 in the plugin); the wlroots helper converts pixels to
 * notches on the C side (`take_discrete_steps` in wayland.c). GNOME's
 * `NotifyPointerAxisDiscrete` is the one wire that reaches this codebase still
 * speaking notches, so it converts here — with the same constant and the same
 * remainder semantics, because one scroll must mean one thing on every desktop.
 */

/**
 * Pixels per wheel notch.
 *
 * The pixels are *content* pixels: what a page actually moves when a physical
 * wheel clicks once. That is a toolkit decision, not a protocol one — Chromium
 * scrolls 53 px per notch on Linux, Firefox three lines (about 57 px), Qt and
 * terminals three lines too — so this is a nominal figure in the middle of
 * them, and the tool surface promises "roughly" this much. It also matches
 * what a browser reports as `deltaY` for one notch, so a human notch on the
 * computer pane arrives on the desktop as about one notch.
 *
 * It is deliberately not libinput's 15 wire units per notch. Those are what a
 * compositor hands a client in `wl_pointer.axis` — degrees of wheel rotation,
 * which toolkits then scale up by a factor of three to seven — so treating
 * them as pixels made every scroll several times longer than it was asked to
 * be, and a 900 px request threw a page all the way to its bottom. The native
 * injectors convert pixels to notches with this constant and emit the
 * continuous axis value as notches × 15 on their own.
 *
 * Keep in sync with `SCROLL_STEP_PX` in
 * apps/server/native/computer-desktop-helper/src/wayland.c,
 * `s_scrollPixelsPerNotch` in
 * apps/server/native/computer-use-kwin/synaracomputeruseplugin.cpp and
 * `SCROLL_PIXELS_PER_NOTCH` in
 * apps/server/native/computer-use-hyprland/synarahyprlandplugin.cpp.
 */
export const SCROLL_STEP_PX = 50;

/**
 * Whole notches owed for a pixel delta that can only be delivered as notches.
 *
 * A delta smaller than a notch truncates to zero steps — rounding up would
 * turn a 2 px trackpad nudge into a full notch and a pixel-speaking stack
 * would scroll further than it was asked to. The sub-notch part comes back as
 * `remainder`, so repeated small deltas add up to a notch across calls and
 * nothing is invented; carry it per axis. Same shape as `take_discrete_steps`
 * in wayland.c, deliberately.
 *
 * Returns `{ steps, remainder }`; feed `remainder` back in with the next delta.
 */
export function takeDiscreteSteps(
  remainder: number,
  delta: number,
): { readonly steps: number; readonly remainder: number } {
  // A non-finite delta would poison the accumulator forever after.
  if (!Number.isFinite(delta) || delta === 0) return { steps: 0, remainder };
  const carried = remainder + delta;
  // The `|| 0` normalizes Math.trunc's negative zero, which would otherwise
  // leak into payloads and strict equality checks.
  const steps = Math.trunc(carried / SCROLL_STEP_PX) || 0;
  return { steps, remainder: carried - steps * SCROLL_STEP_PX };
}
