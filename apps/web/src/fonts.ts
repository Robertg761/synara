// FILE: fonts.ts
// Purpose: Self-hosted webfont faces for every family the app and its pre-React screens use.
// Layer: Web bootstrap side effect
// Exports: none (CSS side effects only)

// Imported from bootstrap.ts rather than main.tsx: the signed-out and pairing-failure
// screens render before `./main` is ever imported and set DM Sans / Geist Mono / JetBrains
// Mono on inline styles. Serving the faces from the bundle also keeps booting free of any
// network dependency (previously a Google Fonts <link> in index.html), which matters
// offline and inside mobile WebViews.
//
// @fontsource-variable packages register their faces under a "<Family> Variable" name, so
// theme/user font values are expanded to those aliases in lib/fontFamily.ts and the base
// stacks in index.css list them explicitly. Cal Sans ships a single 400 cut, which is the
// weight --font-display-family is paired with.
import "@fontsource/cal-sans";
import "@fontsource-variable/dm-sans";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
