// FILE: branding.ts
// Purpose: Application name and build identity for the running web bundle.
// Layer: Web constants
// Depends on: ~/env (isMobileShell), @synara/shared/mobileIdentity
// Exports: APP_BASE_NAME, APP_DISPLAY_NAME, APP_VERSION, resolveClientBuild

import { mobileClientBuild } from "@synara/shared/mobileIdentity";

import { isMobileShell } from "./env";

export const APP_BASE_NAME = "Synara";
const isCanaryDesktop =
  typeof window !== "undefined" && window.location?.protocol === "synara-canary:";
export const APP_DISPLAY_NAME = isCanaryDesktop
  ? "Synara Canary"
  : import.meta.env.DEV
    ? `${APP_BASE_NAME} (Dev)`
    : APP_BASE_NAME;
export const APP_VERSION = import.meta.env.APP_VERSION || "0.0.0";

/**
 * What this client calls itself to the server during WebSocket negotiation. The mobile shell
 * ships the same web bundle at the same version but is a distinct client with its own transport
 * constraints, so it prefixes the version rather than passing as a desktop/browser build. Every
 * `clientBuild` the app reports must come from here, or the server sees one client with two
 * identities.
 */
export function resolveClientBuild(): string {
  return isMobileShell ? mobileClientBuild(APP_VERSION) : APP_VERSION;
}
