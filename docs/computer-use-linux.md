# Computer use on Linux

How the server chooses and hosts a Linux desktop backend. The Cua host (the
macOS beta, and observation-only on Linux) is described in
[computer-use-cua](computer-use-cua/README.md); the native Linux backends share
Synara's computer-use core with it and are documented here, one section per
backend.

## Seat policy

One rule outranks every other decision here: the agent never drives the seat
the human is sitting at. A Linux backend gives the agent a cursor and an input
path of its own and leaves the human's pointer, keyboard focus and active
window untouched, or it does not exist. No shared-seat backend is in the tree,
so none can be selected, forced or fallen back to.

## Core seams

The core is shared with the macOS Cua backend and lives in
`apps/server/src/computer/`. The seams a Linux backend plugs into:

- `ComputerBackend.statusAvailability()`: the passive status read for a
  backend whose desktop boots on demand. `ComputerManager.getStatus` uses it
  for every status read when the backend has one, so the settings screen's
  poll never boots or respawns a desktop; the desktop starts again on the next
  real use or from Set up. Backends without it keep the existing behaviour
  (the passive probe before engagement, the establishing read after).
- `ComputerBackend.resetInputDelivery()`: the full seat hand-back the manager
  runs on every desktop lease change and release, where `clearFocusWindow`
  alone would clear only the aim. A compositor seat outlives the thread that
  drove it.
- `ComputerBackend.dedicatedSeat`: the opt-in a backend sets when the agent
  drives the desktop through a seat of its own. The computer service registers
  the manager's `ComputerGuidanceProfile` (dialect plus this flag) for the
  process, because the session-start guidance is rendered by provider adapters
  that never see the backend. A backend that sets nothing keeps the Cua host's
  wording unchanged.
- `ComputerBackend.textRangeSelection`: `false` refuses `computer_select_text`
  in the manager before the lease is claimed and the window restacked and
  aimed for a dispatch the backend would refuse anyway.

## Backend selection

`Layers/ComputerService.ts` resolves the backend once at startup, with no
fallback in any direction once a choice is made:

1. `SYNARA_COMPUTER_BACKEND`, when set. `fake` and `cua` are platform-neutral;
   the Linux tiers are refused off Linux. An unknown value is not ignored: it
   becomes an unavailable backend whose message lists the names that exist, so
   a typo never boots a different backend and looks like the variable does
   nothing. A forced backend that fails stays failed and says why.
2. The Linux detection tiers in `linuxBackendSelection.ts`, best desktop first.
   `LINUX_BACKEND_CHOICES` and the service layer's `LINUX_BACKENDS` factory
   table are filled by the backend layers; each backend registers its choice,
   its detection tier and its constructor together, so the three cannot drift.
3. The Cua host, on macOS or wherever `SYNARA_CUA_HOST_SOCKET` names an
   endpoint. It comes after the Linux tiers on purpose: the desktop app
   configures its host socket on Linux too, so socket presence cannot be what
   decides between a compositor backend and the observation-only Cua host.
4. Otherwise an unavailable backend that says why.
