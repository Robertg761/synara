# Computer use: GNOME live checklist

Everything GNOME in Tier 2 phase B3 was built against an in-process fake of the portal bus, on a
Fedora KDE box with no GNOME session available. The fake proves our client code follows the portal's
Request/Response convention, latches denials, and dies when the session dies. It proves nothing about
what mutter actually does. This checklist is the list of assumptions that are still assumptions, in
the order that a single sitting at a real GNOME machine should knock them down.

Run it like the Tier 1 live checklists: one pass, notes as you go, then fold the answers into the B3
bullet of `docs/computer-use-tier2-plan.md` as statements of fact. An item that cannot be tested is
worth recording as untested; an item quietly skipped becomes a silent assumption again.

## Before you start

The session must be Wayland (`echo $XDG_SESSION_TYPE`); an X11 GNOME session refuses every capability
by design and tests nothing here. Install `xdg-desktop-portal` and `xdg-desktop-portal-gnome`. Leave
`wl-clipboard` uninstalled for the first pass: its presence changes which clipboard provider the probe
picks, and the portal path is the one that has never run.

Record the environment before the first dialog, because half the open questions are really "which
version of the portal is this":

```
gnome-shell --version
rpm -q xdg-desktop-portal xdg-desktop-portal-gnome   # or dpkg -l
busctl --user introspect org.freedesktop.portal.Desktop /org/freedesktop/portal/desktop \
  | grep -E 'RemoteDesktop|ScreenCast|Clipboard|version|AvailableDeviceTypes'
```

Write down the `RemoteDesktop` and `ScreenCast` interface versions, the `AvailableDeviceTypes` bitmask,
and whether `org.freedesktop.portal.Clipboard` exists at all. Those four numbers decide every branch in
`planPortalProviders`.

Start the server with `SYNARA_COMPUTER_BACKEND=portal` so selection is explicit rather than inferred,
and keep `busctl --user monitor org.freedesktop.portal.Desktop` running in another terminal for the
whole session. The D-Bus trace is the evidence; the UI is only the symptom.

## 1. Nothing happens until something asks

Boot the server, open the computer panel, and stop there.

Pass: no dialog at boot and none at probe, availability is `available`, consent is `not-requested`,
and the bus trace contains no `CreateSession`. Health reads `unavailable` here for one reason only, the
missing capture provider, and the capture message names `pipewire-devel` and `build.sh` rather than
blaming GNOME. Copy the availability string verbatim into the notes; it is user-facing text that has
never been read on the desktop it describes.

## 2. One dialog, one session

Trigger the first mutating action (a click is enough) and watch the trace.

Pass: exactly one `CreateSession`, then `SelectDevices` and `SelectSources` carrying the same session
handle, then one `Start`, and exactly one dialog covering both remote control and screen sharing. The
panel shows `awaiting-consent` while the dialog is up and availability stays `available` throughout.
Approving flips consent to `granted`.

Two dialogs, or a `Start` that returns before the human answers, is the finding that matters most after
item 3: it would mean the joined session is not real on this portal, and the coordinate contract in
item 3 has to be rebuilt on something else.

Then run it again and press Cancel. Denial must latch: no second dialog, no retry loop, and the refusal
is non-retryable. Confirm the only way back is an explicit user action.

## 3. The coordinate contract (plan open question 1, the top risk)

The whole GNOME input path rests on one claim: `Start`'s response carries `streams` as `a(ua{sv})`
with a node id, a `position`, and a `size`, and `NotifyPointerMotionAbsolute` takes coordinates
relative to the stream it names. That is why B3 ships input without touching PipeWire. If it is false,
input on GNOME is wrong everywhere at once.

Copy the `streams` payload out of the trace verbatim, then click a point near the top-left of the
primary monitor, a point in the middle, and a point one pixel inside the bottom-right corner. Repeat
on a second monitor if there is one.

Pass: the pointer lands where the global desktop coordinate space says it should, including the corner
(a clamp error shows up there first). Record whether `position` and `size` are logical or physical
pixels by rerunning at 125% and 150% fractional scaling, and whether each monitor gets its own stream
or the portal hands back one combined stream.

`resolveStreamPoint` in `apps/server/src/computer/portal/portalSession.ts` is the only place a desktop
point becomes a (node, x, y) triple, so a mismatch is a fix in one function. It currently picks the
containing monitor, falls back to the nearest, and clamps to `width - 1` / `height - 1`; the live run
decides whether that is the right transform.

## 4. Keyboard and pointer fidelity

Type mixed-case text, then Ctrl+A, Ctrl+C, Super, the arrow keys, and a drag with a modifier held.

We send `NotifyKeyboardKeycode` with evdev codes, not keysyms, so the layout is the desktop's business.
Verify that deliberately: switch to a French layout and send evdev 30. It must produce whatever that
physical key produces for the human (`q` on azerty), not `a`. If it produces `a`, the portal is doing a
keysym translation we do not know about, and the mapping in the input provider has to change.

Then leave a button and a modifier down and dispose the backend mid-drag. The desktop must not be left
with a stuck key or button: `PortalRemoteDesktopInputProvider` releases held keys and buttons in
`dispose()` before releasing its share of the session, precisely because the session can outlive it.

## 5. The kill switch (plan open question 3)

Run these one at a time, from a granted session, with input in flight where possible: lock the screen,
press Stop in the GNOME screen-sharing indicator, log out and back in, and suspend/resume.

Pass: the session's `Closed` signal arrives, the next action refuses once with the revocation sentence
and is retryable, nothing queues, and no input arrives late after the session is gone. A subsequent
action raises a fresh dialog rather than silently reusing a dead handle.

The dangerous case to time precisely: how long after the screen locks does `Closed` land, and does any
input call succeed in that window? Input landing on a lock screen is the one failure mode here that is
worse than not working.

## 6. Persistence (plan open question 4)

With a grant in hand, restart the server. Then log out, log in, and restart. Then change the monitor
selection (unplug a monitor, or pick a different one in the dialog) and restart again.

Pass: the restore token is replayed on `SelectDevices`, and a re-prompt is acceptable at any point.
What must not happen is a stale token producing a latched denial: the store drops a token the moment
the portal rejects it, and that path needs to be seen working.

Check the file directly: `~/.local/state/synara/computer/portal-restore-tokens.json`, mode 0600, one
key per `{desktop, deviceTypes, screencast}`, and a token that changes after each successful `Start`
(they are single-use). It must never appear in a log.

Record whether `persist_mode: 2` survives a logout on this GNOME at all, and whether the token is bound
to a specific monitor selection.

## 7. Clipboard, both paths (plan open question 6)

Which provider the probe picks is a decision worth testing on both sides.

Without `wl-clipboard` installed, the plan picks `portal-selection`. Verify `RequestClipboard` is called
before `Start`, check what `clipboard_enabled` comes back as in the `Start` response, read a selection
an app has copied, then write one and paste it in a different app. The write is an ownership model:
the paste must work while the server is alive, and every `SelectionTransfer` must be completed even
when we cannot produce the requested type, or the pasting app hangs on a pipe forever.

Then install `wl-clipboard` and restart. On mutter 48+ the probe should see `ext_data_control_manager_v1`
and pick `wl-clipboard` instead; confirm `wl-paste --list-types` actually works on this GNOME before
trusting that branch.

Record which path was taken, whether `org.freedesktop.portal.Clipboard` exists, and whether
`clipboard_enabled` came back false despite `RequestClipboard` succeeding — the provider treats a
missing key as enabled, and a portal that answers false without saying so would be the reason to change
that.

## 8. Read the refusals on a real screen

Ask for a screenshot, a window list, and a window-scoped capture, and read what comes back as a user
would.

Pass: each refusal names a concrete next step. Capture must name the PipeWire headers and `build.sh`
and offer `SYNARA_COMPUTER_NESTED=window` as the thing that works today. Windows must name the
`synara-computer-use@synara.dev` Shell extension and the coordinate-only workflow, not "GNOME is
unsupported". Anything that reads as a bug report rather than an instruction is a copy fix.

## 9. Monitor and scaling matrix

At minimum: one monitor at 100%, one monitor at 150% fractional, and two monitors at mixed scale with
the secondary placed to the left of the primary so the layout has negative coordinates. Click a known
point on each monitor in each configuration and keep the `streams` payload for each.

The negative-origin layout is the same shape as the Tier 1 run-2 clamp bug, so it is the configuration
most likely to find something.

## 10. Bank these while you are there (not B3 scope)

- Plan open question 2: whether the Shell extension's `get_frame_rect()` coordinates equal the stream
  coordinate space under fractional scaling and multiple monitors. This is B4's correctness risk, and
  item 3 above produces exactly the data needed to answer it.
- Plan open question 5: whether the AT-SPI registry is reachable on GNOME without `toolkit-accessibility`,
  and whether extents are frame-relative. Decides whether semantic targeting exists on GNOME at all.
- Plan open question 7: PipeWire crop-plus-downscale throughput at 5120x2520 against the 500 ms still
  poll. Needs the native capture work first, but the monitor geometry is worth measuring now.
- libei: `PortalSession.connectToEIS()` already returns the EIS fd, and nothing consumes it. Time how
  long after `Start` the EIS devices become usable, and compare input latency under load against the
  `NotifyKeyboardKeycode` path we ship. That comparison is the argument for or against doing the libei
  work at all.

## Reporting

Fold the answers into the phase B3 bullet in `docs/computer-use-tier2-plan.md` the way B1 and B2 were
recorded, and delete the corresponding entries from the plan's "Unknowns that need a live GNOME session"
list as each becomes a fact. Paste the real `streams` payload somewhere durable; it is the single most
useful artifact this checklist produces.
