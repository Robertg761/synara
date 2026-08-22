/**
 * Clipboard through the portal's selection interface.
 *
 * `org.freedesktop.portal.Clipboard` arrived alongside RemoteDesktop v2 and
 * works only inside a granted remote-control session — which is the whole
 * reason it exists here rather than as a standalone provider: on GNOME there is
 * no `wlr-data-control`, so `wl-paste` cannot read a selection it does not own,
 * and the portal session is the only clipboard a non-focused process can reach.
 *
 * Reading is a request for a file descriptor and a read. Writing is not: the
 * portal's model is *ownership*, so `SetSelection` announces which types this
 * session can produce and the bytes are handed over later, once per pasting
 * application, through `SelectionTransfer`. That means a write is only durable
 * for as long as this provider is alive to answer transfers — which is honest,
 * and is exactly how every other Wayland clipboard owner behaves.
 */
import { Socket } from "node:net";

import { ComputerBackendError, MAX_COMPUTER_CLIPBOARD_BYTES } from "../ComputerBackend.ts";
import { decodeUtf8Clamped } from "../utf8Truncation.ts";
import type { PortalSession } from "./portalSession.ts";
import type { PortalClipboardProvider, PortalProviderId } from "./providers.ts";

/**
 * In preference order. The charset-qualified type is what modern toolkits
 * offer; the bare one is what older ones ask for, and offering both is the
 * difference between a paste working in GTK4 and working everywhere.
 */
export const PORTAL_CLIPBOARD_TEXT_MIME_TYPES = [
  "text/plain;charset=utf-8",
  "text/plain",
  "UTF8_STRING",
] as const;

/**
 * How long a clipboard transfer may stay silent.
 *
 * The 10 s bus timeout covers only the descriptor handout; the bytes themselves
 * arrive whenever the current owner feels like writing them, so without a
 * deadline of its own a stalled paste target hangs `computer_read_clipboard`
 * forever while the lease sits held.
 */
const CLIPBOARD_TRANSFER_TIMEOUT_MS = 10_000;

export interface PortalSelectionClipboardProviderOptions {
  /** Test seams: the real ones wrap a portal file descriptor in a socket. */
  readonly readFd?: (fd: number, limit: number, timeoutMs?: number) => Promise<Buffer>;
  readonly writeFd?: (fd: number, bytes: Buffer) => Promise<void>;
  /**
   * How long one clipboard transfer may stay silent before it is abandoned.
   * Tests shorten it; the default is `CLIPBOARD_TRANSFER_TIMEOUT_MS`.
   */
  readonly transferTimeoutMs?: number;
}

export class PortalSelectionClipboardProvider implements PortalClipboardProvider {
  readonly id: PortalProviderId = "portal-selection";

  private readonly readFd: (fd: number, limit: number, timeoutMs?: number) => Promise<Buffer>;
  private readonly writeFd: (fd: number, bytes: Buffer) => Promise<void>;
  private readonly transferTimeoutMs: number;
  /** The bytes this session has claimed it can produce, if any. */
  private offered: Buffer | undefined;
  private unsubscribeTransfer: (() => void) | undefined;

  constructor(
    private readonly session: PortalSession,
    /** Releases this provider's share of the session. See `sharePortalSession`. */
    private readonly release: () => Promise<void>,
    options: PortalSelectionClipboardProviderOptions = {},
  ) {
    this.readFd = options.readFd ?? readFileDescriptor;
    this.writeFd = options.writeFd ?? writeFileDescriptor;
    this.transferTimeoutMs = options.transferTimeoutMs ?? CLIPBOARD_TRANSFER_TIMEOUT_MS;
  }

  async read(): Promise<string> {
    await this.requireClipboard();
    let lastError: unknown;
    for (const mimeType of PORTAL_CLIPBOARD_TEXT_MIME_TYPES) {
      try {
        const fd = await this.session.selectionRead(mimeType);
        // Two layers of the same deadline: the default readFd destroys its own
        // socket on loss, and this race guarantees the caller an answer even
        // when a custom readFd has none.
        const bytes = await abandonAfter(
          this.readFd(fd, MAX_COMPUTER_CLIPBOARD_BYTES, this.transferTimeoutMs),
          this.transferTimeoutMs,
        );
        // The read stops at a byte count, which can land inside a multi-byte
        // character, so the tail is trimmed back to a whole one here.
        return decodeUtf8Clamped(bytes, MAX_COMPUTER_CLIPBOARD_BYTES);
      } catch (error) {
        // A structured failure — a transfer that timed out rather than a type
        // the owner does not offer — is not part of the negotiation, and
        // retrying it under the next mime name only stalls the same way again.
        if (error instanceof ComputerBackendError) throw error;
        // The portal answers with an error for a type the current owner does
        // not offer, so the loop is the negotiation: try the types we can
        // decode, and only give up when none of them worked.
        lastError = error;
      }
    }
    throw new ComputerBackendError(
      "The clipboard holds nothing Synara can read as text. " +
        `The desktop portal refused every text type (${PORTAL_CLIPBOARD_TEXT_MIME_TYPES.join(", ")})` +
        `${lastError instanceof Error ? `: ${lastError.message}` : ""}. ` +
        "Copy text rather than an image or a file before reading the clipboard.",
      { retryable: false },
    );
  }

  async write(text: string): Promise<void> {
    await this.requireClipboard();
    this.offered = Buffer.from(text, "utf8");
    // Subscribed before the claim, because the first transfer request can
    // arrive as soon as another application notices the selection changed.
    this.unsubscribeTransfer ??= await this.session.onSelectionTransfer((mimeType, serial) => {
      void this.serveTransfer(mimeType, serial);
    });
    await this.session.setSelection(PORTAL_CLIPBOARD_TEXT_MIME_TYPES);
  }

  /**
   * Answers one paste.
   *
   * `SelectionWriteDone` is not optional and not best-effort: an application
   * that asked for the bytes blocks on the descriptor until it is closed and on
   * the done signal until it arrives, so a transfer this provider abandons is a
   * paste that hangs in someone else's window.
   */
  private async serveTransfer(mimeType: string, serial: number): Promise<void> {
    const offered = this.offered;
    if (offered === undefined || !PORTAL_CLIPBOARD_TEXT_MIME_TYPES.includes(mimeType as never)) {
      await this.session.selectionWriteDone(serial, false).catch(() => undefined);
      return;
    }
    try {
      const fd = await this.session.selectionWrite(serial);
      await this.writeFd(fd, offered);
      await this.session.selectionWriteDone(serial, true);
    } catch {
      await this.session.selectionWriteDone(serial, false).catch(() => undefined);
    }
  }

  private async requireClipboard(): Promise<void> {
    if (await this.session.clipboardEnabled()) return;
    throw new ComputerBackendError(
      "This desktop's portal granted remote control but no clipboard access, so the clipboard cannot be read or written. " +
        "The Clipboard portal interface needs xdg-desktop-portal 1.18 or newer together with a desktop backend that implements it.",
      { retryable: false },
    );
  }

  async dispose(): Promise<void> {
    this.unsubscribeTransfer?.();
    this.unsubscribeTransfer = undefined;
    // The offered bytes are dropped deliberately: once this provider stops
    // answering transfers, claiming to still own the selection would leave the
    // desktop's clipboard pointing at something nothing will serve.
    this.offered = undefined;
    await this.release();
  }
}

/**
 * Portal descriptors are pipes, and a pipe is a stream rather than a file: it
 * has no size to stat and no offset to seek, so the only way to know how much
 * there is is to read until the writer closes.
 */
/**
 * Rejects with the structured stall error when `work` outlives `timeoutMs`.
 *
 * Losing the race does not cancel `work` — a promise cannot be — which is why
 * the default `readFileDescriptor` destroys its own socket on the same clock;
 * this is the guarantee the caller sees either way.
 */
function abandonAfter<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new ComputerBackendError(
            `The desktop portal acknowledged a clipboard transfer but sent nothing within ` +
              `${timeoutMs} ms, so the read was abandoned.`,
            { retryable: true },
          ),
        ),
      timeoutMs,
    );
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Portal descriptors are pipes, and a pipe is a stream rather than a file: it
 * has no size to stat and no offset to seek, so the only way to know how much
 * there is is to read until the writer closes. Exported because the stall test
 * exercises the real deadline against a real pipe.
 */
export function readFileDescriptor(fd: number, limit: number, timeoutMs?: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const socket = new Socket({ fd, readable: true, writable: false });
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    // A writer that never closes the pipe would otherwise hold this promise
    // — and the desktop lease with it — forever.
    const timer = setTimeout(() => {
      socket.destroy();
      settle(() =>
        reject(
          new ComputerBackendError(
            `The desktop portal acknowledged a clipboard transfer but sent nothing within ` +
              `${timeoutMs ?? CLIPBOARD_TRANSFER_TIMEOUT_MS} ms, so the read was abandoned.`,
            { retryable: true },
          ),
        ),
      );
    }, timeoutMs ?? CLIPBOARD_TRANSFER_TIMEOUT_MS);
    timer.unref?.();
    socket.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      chunks.push(chunk);
      // Truncated rather than failed: a clipboard holding a whole document is a
      // normal thing for a human to have, and refusing to read any of it would
      // be worse for the agent than reading the first megabyte.
      if (total >= limit) {
        socket.destroy();
        settle(() => resolve(Buffer.concat(chunks).subarray(0, limit)));
      }
    });
    socket.on("error", (error: Error) => {
      settle(() => reject(error));
    });
    socket.on("close", () => {
      settle(() => resolve(Buffer.concat(chunks).subarray(0, limit)));
    });
  });
}

function writeFileDescriptor(fd: number, bytes: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = new Socket({ fd, readable: false, writable: true });
    socket.on("error", reject);
    socket.end(bytes, () => resolve());
  });
}
