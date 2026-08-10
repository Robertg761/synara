import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";

// Webfont faces are loaded once from ./fonts on the bootstrap path (see src/fonts.ts).
import "./index.css";

import { appHistory } from "./appNavigation";
import { getRouter } from "./router";
import { APP_DISPLAY_NAME } from "./branding";
import { appRuntime } from "./env";

const router = getRouter(appHistory);

document.title = APP_DISPLAY_NAME;

// CSS selects on data-runtime="electron"; the mobile shell writes "mobile" and
// a plain browser tab leaves the attribute unset.
if (appRuntime !== "browser") {
  document.documentElement.dataset.runtime = appRuntime;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
