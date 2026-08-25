// FILE: connect.tsx
// Purpose: Mobile connect/pairing screen. Turns a pasted pairing link (or bare token) plus a
//          server address into an owner session on a self-hosted Synara server, stores it in the
//          shell's secure session, and returns to the app.
// Layer: Route screen
// Exports: Route for `/connect`
// Depends on: ~/lib/pairingUrl (parse/normalize), ~/lib/bearerBootstrap (the exchange),
//             ~/shellSession (persist), ~/lib/serverEndpoint (saved server origin),
//             ~/connectRouteSearch (why the app sent this device here),
//             ~/appRelaunch (restart the app against the newly paired server)

import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useState, type FormEvent } from "react";

import { relaunchAppAtRoot } from "~/appRelaunch";
import { APP_DISPLAY_NAME } from "~/branding";
import { parseConnectRouteSearch, type ConnectRouteSearch } from "~/connectRouteSearch";
import { isMobileShell } from "~/env";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { Label } from "~/components/ui/label";
import { Separator } from "~/components/ui/separator";
import { Spinner } from "~/components/ui/spinner";
import { BEARER_BOOTSTRAP_PATH, requestBearerSession } from "~/lib/bearerBootstrap";
import { normalizeServerBaseUrl, parsePairingInput } from "~/lib/pairingUrl";
import { resolveWsHttpUrl } from "~/lib/serverEndpoint";
import { hydrateShellSession, isShellPaired, pairFromCredential } from "~/shellSession";

/** Every user-facing failure string, in one place so the screen's voice stays consistent. */
const MESSAGES = {
  invalidServerUrl: "Enter a valid server URL, for example http://192.168.1.5:3773",
  missingCredential: "Paste a Synara pairing link or token.",
  credentialIsServerUrl:
    "That is a server address, not a pairing token. Paste the pairing link or its token here.",
  credentialUnparsable: "That does not look like a pairing link or token. Copy the whole link.",
  rejected:
    "This server rejected the pairing link. It may have expired or already been used — create a new one in Synara and try again.",
  noSessionToken: "The server did not return a session token.",
  storeFailed: "Could not save this connection on this device. Try again.",
  signedOut: "The server signed this device out. Pair again to reconnect.",
} as const;

function unreachableMessage(serverUrl: string): string {
  return `Could not reach ${serverUrl}. Check the address, and make sure this device is on the same network as the server.`;
}

/**
 * The http(s) origin of the already-paired server, for the "reconnect" affordance. Read through
 * `resolveWsHttpUrl` so the screen shows exactly the server the transport would dial, rather than
 * re-deriving the ws → http mapping a second time.
 */
function readPairedServerOrigin(): string | null {
  if (!isShellPaired()) return null;
  try {
    return new URL(resolveWsHttpUrl("/")).origin;
  } catch {
    return null;
  }
}

function ConnectRouteView() {
  const navigate = useNavigate();
  const { reason } = Route.useSearch();
  const serverFieldId = useId();
  const pairingFieldId = useId();
  const pairingHintId = useId();

  const [serverUrlInput, setServerUrlInput] = useState("");
  const [pairingInput, setPairingInput] = useState("");
  const [pairingRevealed, setPairingRevealed] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairedServerOrigin, setPairedServerOrigin] = useState<string | null>(null);

  // Secure storage is async: a user who lands here manually may still have a usable session that
  // has not been read into memory yet, and it is what the reconnect affordance below offers.
  useEffect(() => {
    let cancelled = false;
    void hydrateShellSession().then(() => {
      if (cancelled) return;
      const origin = readPairedServerOrigin();
      setPairedServerOrigin(origin);
      // Prefill only — the user can still point this device at a different server.
      if (origin) setServerUrlInput((current) => (current.length > 0 ? current : origin));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const normalizedServerUrl = normalizeServerBaseUrl(serverUrlInput);
  const insecure = normalizedServerUrl?.startsWith("http://") === true;
  const canSubmit = serverUrlInput.trim().length > 0 && pairingInput.trim().length > 0;

  // A full pairing link pasted into either field fills both, so there is one "paste anything"
  // affordance without giving up the explicit server field. Only the field NOT being edited is
  // ever rewritten: replacing the active field's value with a normalized parse would jump the
  // caret mid-typing. Submit re-parses both fields, so the raw link staying in place is fine.
  function handleServerUrlChange(value: string): void {
    setError(null);
    setServerUrlInput(value);
    const parsed = parsePairingInput(value);
    if (parsed.serverUrl !== null && parsed.credential !== null) {
      setPairingInput(parsed.credential);
    }
  }

  function handlePairingInputChange(value: string): void {
    setError(null);
    setPairingInput(value);
    const parsed = parsePairingInput(value);
    if (parsed.serverUrl !== null && parsed.credential !== null) {
      setServerUrlInput(parsed.serverUrl);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (connecting) return;

    const serverUrl = normalizeServerBaseUrl(serverUrlInput);
    if (serverUrl === null) {
      setError(MESSAGES.invalidServerUrl);
      return;
    }
    const parsedPairing = parsePairingInput(pairingInput);
    if (parsedPairing.kind === "empty") {
      setError(MESSAGES.missingCredential);
      return;
    }
    if (parsedPairing.kind === "serverUrl") {
      setError(MESSAGES.credentialIsServerUrl);
      return;
    }
    if (parsedPairing.credential === null) {
      setError(MESSAGES.credentialUnparsable);
      return;
    }

    setConnecting(true);
    setError(null);
    const result = await requestBearerSession(
      `${serverUrl}${BEARER_BOOTSTRAP_PATH}`,
      parsedPairing.credential,
    );
    if (!result.ok) {
      setConnecting(false);
      setError(
        result.reason === "unreachable"
          ? unreachableMessage(serverUrl)
          : result.reason === "rejected"
            ? MESSAGES.rejected
            : MESSAGES.noSessionToken,
      );
      return;
    }

    try {
      await pairFromCredential({ serverUrl, sessionToken: result.sessionToken });
    } catch {
      setConnecting(false);
      setError(MESSAGES.storeFailed);
      return;
    }
    // Relaunch rather than navigate. This device may already have a transport connected to a
    // different server, and it is a singleton that resolved its endpoint once: an in-place
    // navigation would leave WebSocket traffic on the old server while HTTP goes to the new one,
    // with credentials straddling both. The session is persisted above, so the fresh document
    // comes back paired. The credential and token only ever lived in memory and in secure
    // storage, so there is nothing to scrub from the URL.
    relaunchAppAtRoot();
  }

  return (
    // `my-auto` (not `justify-center`) centers the card: a form taller than the viewport must stay
    // fully scrollable, and a centered flex item clips its overflow at the top.
    <main className="flex h-dvh w-full justify-center overflow-y-auto bg-background px-5 pt-safe-t pb-10 text-foreground">
      <form
        className="my-auto flex w-full max-w-md flex-col gap-6 pt-10 pb-keyboard-safe"
        onSubmit={(event) => void handleSubmit(event)}
      >
        <header className="flex flex-col gap-2">
          <p className="font-medium text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground uppercase tracking-[0.14em]">
            {APP_DISPLAY_NAME}
          </p>
          <h1 className="text-2xl font-semibold leading-tight tracking-tight">
            Connect to your Synara server.
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Open Synara on the computer running your agents, create a pairing link under Settings →
            Remote access, then paste it below.
          </p>
        </header>

        {/* Why this device is back on the pairing screen. Informational, not an error: nothing
            the user did failed, and the server is not necessarily unreachable. */}
        {reason === "signed-out" ? (
          <Alert variant="info">
            <AlertDescription>{MESSAGES.signedOut}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-col gap-4 rounded-xl border border-border bg-card/60 p-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor={serverFieldId}>Server URL</Label>
            <InputGroup>
              <InputGroupInput
                id={serverFieldId}
                value={serverUrlInput}
                onChange={(event) => handleServerUrlChange(event.target.value)}
                placeholder="http://192.168.1.5:3773"
                inputMode="url"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                disabled={connecting}
              />
            </InputGroup>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={pairingFieldId}>Pairing link or token</Label>
            <InputGroup>
              <InputGroupInput
                id={pairingFieldId}
                aria-describedby={pairingHintId}
                value={pairingInput}
                onChange={(event) => handlePairingInputChange(event.target.value)}
                placeholder="Paste your pairing link"
                type={pairingRevealed ? "text" : "password"}
                inputMode="url"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                disabled={connecting}
              />
              <InputGroupAddon align="inline-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={connecting}
                  onClick={() => setPairingRevealed((revealed) => !revealed)}
                >
                  {pairingRevealed ? "Hide" : "Show"}
                </Button>
              </InputGroupAddon>
            </InputGroup>
            <p id={pairingHintId} className="text-xs text-muted-foreground">
              Pasting a full link fills in the server URL too.
            </p>
          </div>

          {insecure ? (
            <Alert variant="warning" size="sm">
              <AlertDescription>
                This connection is unencrypted. That is fine on your own network — use HTTPS to
                reach Synara from outside it.
              </AlertDescription>
            </Alert>
          ) : null}

          {error === null ? null : (
            <Alert variant="error" size="sm">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Button type="submit" size="lg" disabled={!canSubmit || connecting}>
            {connecting ? <Spinner className="size-4" /> : null}
            {connecting ? "Connecting…" : "Connect"}
          </Button>

          {pairedServerOrigin === null ? null : (
            <>
              <Separator />
              <div className="flex flex-col gap-2">
                <p className="text-xs text-muted-foreground">
                  A saved connection to {pairedServerOrigin} is already on this device.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  disabled={connecting}
                  onClick={() => void navigate({ to: "/", replace: true })}
                >
                  Reconnect saved server
                </Button>
              </div>
            </>
          )}
        </div>

        <p className="text-center text-xs text-muted-foreground">
          Local-first. Your pairing stays on this device.
        </p>
      </form>
    </main>
  );
}

export const Route = createFileRoute("/connect")({
  validateSearch: (raw: Record<string, unknown>): ConnectRouteSearch =>
    parseConnectRouteSearch(raw),
  // Pairing only exists on the mobile shell. Desktop and plain browsers must never reach this
  // screen: they have no bridge to persist a session into, and `pairFromCredential` refuses to
  // run without one, so the form could only ever end in an error.
  beforeLoad: () => {
    if (!isMobileShell) throw redirect({ to: "/" });
  },
  component: ConnectRouteView,
});
