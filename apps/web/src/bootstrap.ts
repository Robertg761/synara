// FILE: bootstrap.ts
// Purpose: Completes synchronous renderer storage migration before any app store can hydrate.

import "./storageOriginMigration";
// Must stay on the synchronous path: the signed-out / pairing screens below render
// without ever importing ./main.
import "./fonts";

import { bootstrapSignedOutScreen } from "./authSignedOut";
import { isNativeShell } from "./env";
import { readBootstrapLocation } from "./lib/bootstrapLocation";
import { ensureMediaAuthToken } from "./mediaAuthToken";
import { bootstrapPairingSession } from "./pairingBootstrap";
import { hydrateShellSession } from "./shellSession";

// One read of window.location for the whole pre-React path. Both screens are addressed by
// pathname under browser history and by fragment under hash history (native shells), so the
// route is resolved once here and injected instead of re-derived per screen.
const bootstrapLocation = readBootstrapLocation(window.location, { nativeShell: isNativeShell });

if (!bootstrapSignedOutScreen({ location: bootstrapLocation })) {
  void bootstrapPairingSession({ location: bootstrapLocation }).then((result) => {
    if (result === "not-pairing" || result === "paired") {
      // The mobile shell keeps its paired server in async secure storage; main's transport
      // reads it synchronously, so it has to be in memory first. No-op off the mobile shell.
      return hydrateShellSession().then(() => {
        // Same reason, one layer up: media URLs are built synchronously during render, so start
        // minting the credential now rather than letting the first painted icon discover it is
        // missing. Not awaited — a slow or unreachable server must not hold up the app, and every
        // media URL degrades to an unauthenticated one until it lands.
        void ensureMediaAuthToken();
        return import("./main");
      });
    }
  });
}
