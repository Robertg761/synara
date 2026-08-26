/**
 * Screen capture through `zwlr_screencopy_manager_v1`.
 *
 * Like the virtual devices, screencopy is unprivileged: a wlroots compositor
 * hands any session client a copy of an output's framebuffer with no portal and
 * no dialog. That makes it the capture provider wherever it exists, because the
 * PipeWire/ScreenCast alternative cannot be opened without prompting.
 *
 * The protocol captures *one output* at a time in that output's own coordinate
 * space. Everything above expects one desktop-space image, so the helper does
 * the compositing, the cropping, the scale-aware resampling and the PNG
 * encoding in C — the alternative is moving raw framebuffers of every monitor
 * through a pipe into Node twice a second. This class only converts requests
 * into helper calls and hands back the bytes.
 */
import type { ComputerRect } from "@synara/contracts";

import type { DesktopHelperTransport } from "./desktopHelperClient.ts";
import type { PortalCaptureProvider, PortalCapturedImage, PortalProviderId } from "./providers.ts";

export class WlrScreencopyProvider implements PortalCaptureProvider {
  readonly id: PortalProviderId = "wlr-screencopy";

  constructor(
    private readonly helper: DesktopHelperTransport,
    private readonly release: () => Promise<void>,
  ) {}

  /**
   * The union of every output, read live rather than cached: a monitor being
   * plugged in, unplugged, or rearranged changes the coordinate space every
   * click is expressed in, and a stale rect would put clicks on the wrong
   * screen for as long as the cache held.
   */
  async workspaceRect(): Promise<ComputerRect> {
    return (await this.helper.outputs()).workspace;
  }

  /**
   * The returned region is what was actually captured — the request clipped to
   * the outputs — not what was asked for. A request that overhangs the desktop
   * would otherwise produce an image whose pixel-to-desktop mapping is off by
   * the overhang, which is exactly the class of error that puts a click a few
   * hundred pixels from the button the model aimed at.
   */
  async captureRegion(region: ComputerRect, maxDimension: number): Promise<PortalCapturedImage> {
    const captured = await this.helper.capture({ region, maxDimension });
    return { bytes: captured.bytes, region: captured.region };
  }

  dispose(): Promise<void> {
    return this.release();
  }
}
