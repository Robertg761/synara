/**
 * The clipboard, through the wl-clipboard binaries.
 *
 * Tier 1 already reads and writes the selection this way and every rule it
 * learned applies unchanged — the empty-clipboard exit status, the non-text
 * refusal, the byte ceiling, the fact that the selection belongs to seat0 and
 * synthesizing Ctrl+C would be a lie — so `wlClipboard.ts` is reused verbatim
 * and this class is only the provider-slot adapter around it.
 *
 * wl-copy and wl-paste need `zwlr_data_control_manager_v1` (or ext-data-control)
 * to read a selection they do not own; the probe checks for the global before
 * this provider is constructed, because without it the binaries are installed
 * and still cannot answer.
 */
import {
  readWlClipboard,
  spawnClipboardCommand,
  writeWlClipboard,
  type ClipboardCommandRunner,
} from "../wlClipboard.ts";
import type { PortalClipboardProvider, PortalProviderId } from "./providers.ts";

export class WlClipboardProvider implements PortalClipboardProvider {
  readonly id: PortalProviderId = "wl-clipboard";

  constructor(private readonly run: ClipboardCommandRunner) {}

  read(): Promise<string> {
    return readWlClipboard(this.run);
  }

  write(text: string): Promise<void> {
    return writeWlClipboard(this.run, text);
  }

  /** Each call is its own short-lived process; there is nothing to hold open. */
  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * `env` is how a nested compositor's clipboard is reached: wl-clipboard talks
 * to whichever `WAYLAND_DISPLAY` it is handed, so the same provider addresses
 * the ambient session and an isolated one.
 */
export function createWlClipboardProvider(env?: NodeJS.ProcessEnv): WlClipboardProvider {
  return new WlClipboardProvider((spec) => spawnClipboardCommand(spec, env));
}
