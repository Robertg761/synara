// FILE: shellPairingGate.ts
// Purpose: Whether the mobile shell may enter the authenticated app, plus the recovery for the one
//          answer that is neither yes nor no — secure storage that did not answer at all. Split out
//          of the chat route so the decision and its recovery are testable on their own.
// Layer: Web app routing utility
// Depends on: ./shellSession (hydration), ./appRelaunch (restart once storage answers)
// Exports: ShellPairingEntry, resolveShellPairingEntry, resetShellPairingGateForTests

import { relaunchAppAtRoot } from "./appRelaunch";
import { hydrateShellSession } from "./shellSession";

export type ShellPairingEntry = "enter" | "connect";

/**
 * Backoff for re-reading a keystore that refused. The device this runs on is unusable meanwhile —
 * no endpoint, no bearer, the transport dialling the WebView's own origin — so the early attempts
 * are quick, and the tail keeps a device that unlocks minutes after a reboot from needing the user
 * to relaunch the app themselves.
 */
const RECOVERY_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000] as const;
const RECOVERY_MAX_DELAY_MS = 30_000;

// One loop per document. Every navigation into the app passes through this gate, and re-arming per
// navigation would multiply the reads against storage that is already struggling.
let recoveryArmed = false;

function recoveryDelayMs(attempt: number): number {
  return RECOVERY_DELAYS_MS[attempt] ?? RECOVERY_MAX_DELAY_MS;
}

function delay(millis: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, millis));
}

/**
 * `hydrateShellSession` is total by contract, but the gate sits in `beforeLoad`, where a thrown
 * error becomes a route error boundary instead of a decision. A read that failed in a way the
 * hydration layer did not anticipate is exactly the "storage did not answer" case, so it is
 * collapsed into it here rather than being allowed to take the route down.
 */
function readHydration(): Promise<"paired" | "unpaired" | "unavailable"> {
  return hydrateShellSession().catch(() => "unavailable" as const);
}

/**
 * Re-read storage until it answers, then restart the app so the answer is applied from scratch.
 *
 * Relaunching rather than patching state in place is the point: the endpoint chain and the
 * transport singleton were both resolved against "no paired server", and a fresh document is the
 * only thing that rebuilds every one of them consistently. It also means this loop needs no
 * opinion about what the answer was — `paired` comes back into a working app, `unpaired` comes
 * back into this same gate, which redirects to the connect screen.
 *
 * Deliberately unbounded. It only ever runs on a device that is paired as far as anyone knows but
 * cannot be read, where giving up strands exactly the user it exists for; the capped backoff keeps
 * the cost of waiting flat.
 */
async function recoverUnreadablePairing(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    await delay(recoveryDelayMs(attempt));
    const result = await readHydration();
    if (result === "unavailable") continue;
    relaunchAppAtRoot();
    return;
  }
}

/**
 * Whether this navigation may enter the authenticated app.
 *
 * Only a definitive "nothing is stored" sends the device to pairing. A read that never answered is
 * not evidence the pairing is gone, and dumping a paired user on the connect screen loses their
 * session for good — so the app loads, and the recovery above brings the device back without the
 * user having to do anything.
 */
export async function resolveShellPairingEntry(): Promise<ShellPairingEntry> {
  const result = await readHydration();
  if (result === "unpaired") return "connect";
  if (result === "unavailable" && !recoveryArmed) {
    recoveryArmed = true;
    void recoverUnreadablePairing();
  }
  return "enter";
}

export function resetShellPairingGateForTests(): void {
  recoveryArmed = false;
}
