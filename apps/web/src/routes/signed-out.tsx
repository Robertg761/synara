// FILE: signed-out.tsx
// Purpose: Render the signed-out screen as a real in-app route, so a revoked session lands
//          somewhere under hash history (native shells) where a path navigation cannot be served.
// Layer: Route screen
// Exports: Signed-out route component for `/signed-out`

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { SIGNED_OUT_SCREEN } from "~/lib/signedOutScreenCopy";

// Copy and structure are shared with the pre-React static renderer in authSignedOut.ts, which
// paints this same screen when the route is entered by a full document load.
function SignedOutRouteView() {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    document.title = SIGNED_OUT_SCREEN.documentTitle;
    // Matches the static renderer: the heading takes focus so the announcement is not lost
    // when the whole app is replaced by this screen.
    headingRef.current?.focus();
  }, []);

  return (
    <main
      aria-labelledby={SIGNED_OUT_SCREEN.headingId}
      className="grid min-h-screen place-items-center bg-background p-8 text-foreground"
    >
      <section className="relative w-full max-w-[560px] overflow-hidden border border-border bg-card p-8 shadow-[12px_12px_0_var(--color-black)] sm:p-14">
        <div aria-hidden="true" className="absolute top-0 right-0 h-2 w-32 bg-primary" />
        <p className="m-0 font-mono text-xs font-semibold tracking-[0.16em] text-primary uppercase">
          {SIGNED_OUT_SCREEN.eyebrow}
        </p>
        <h1
          ref={headingRef}
          id={SIGNED_OUT_SCREEN.headingId}
          tabIndex={-1}
          className="mt-6 max-w-[470px] text-4xl leading-[0.96] font-semibold tracking-[-0.05em] text-foreground outline-none sm:text-5xl"
        >
          {SIGNED_OUT_SCREEN.heading}
        </h1>
        <p className="mt-7 max-w-[440px] text-base leading-relaxed text-muted-foreground">
          {SIGNED_OUT_SCREEN.body}
        </p>
      </section>
    </main>
  );
}

export const Route = createFileRoute("/signed-out")({
  component: SignedOutRouteView,
});
