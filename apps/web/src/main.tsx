import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";

// Webfont faces are loaded once from ./fonts on the bootstrap path (see src/fonts.ts).
import "./index.css";

import { appHistory } from "./appNavigation";
import { getRouter } from "./router";
import { APP_DISPLAY_NAME } from "./branding";
import { appRuntime, isElectron } from "./env";
import { isMacPlatform } from "./lib/utils";

const router = getRouter(appHistory);

document.title = APP_DISPLAY_NAME;

// CSS selects on data-runtime="electron"; the mobile shell writes "mobile" and
// a plain browser tab leaves the attribute unset.
if (appRuntime !== "browser") {
  document.documentElement.dataset.runtime = appRuntime;
}
// macOS desktop windows are transparent vibrancy windows (see getWindowMaterialOptions
// in apps/desktop), and Chromium cannot render `backdrop-filter` inside transparent
// windows — frosted surfaces must fall back to a more opaque fill (see index.css).
if (isElectron && isMacPlatform(navigator.platform)) {
  document.documentElement.dataset.windowTransparent = "true";
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
