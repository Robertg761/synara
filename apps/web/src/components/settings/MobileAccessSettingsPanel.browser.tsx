// FILE: MobileAccessSettingsPanel.browser.tsx
// Purpose: Lock the owner-gated pairing flow, endpoint gating, and credential redaction.
// Layer: Browser UI test

import "../../index.css";

import { decodeMobilePairingDeepLink } from "@synara/shared/mobilePairing";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const CREDENTIAL = "pair-secret-do-not-render-9f2c1d";

const harness = vi.hoisted(() => ({
  getStatus: vi.fn(),
  listAccess: vi.fn(),
  createPairingCredential: vi.fn(),
  revokePairingLink: vi.fn(),
  revokeClientSession: vi.fn(),
  copyTextToClipboard: vi.fn((_value: string) => Promise.resolve()),
  toastAdd: vi.fn(),
}));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    server: {
      mobileAccess: {
        getStatus: harness.getStatus,
        listAccess: harness.listAccess,
        createPairingCredential: harness.createPairingCredential,
        revokePairingLink: harness.revokePairingLink,
        revokeClientSession: harness.revokeClientSession,
      },
    },
  }),
}));

vi.mock("~/hooks/useCopyToClipboard", () => ({
  copyTextToClipboard: harness.copyTextToClipboard,
}));

vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: harness.toastAdd },
}));

import { MobileAccessSettingsPanel } from "./MobileAccessSettingsPanel";

function trustedProxyStatus() {
  return {
    enabled: true,
    mode: "trusted-proxy",
    reachability: "trusted-proxy",
    environmentId: "env-local",
    pairingBaseUrl: "https://mac.tail1234.ts.net",
    pairingBlockedReason: null,
    insecureDevelopmentAccess: false,
    privateLanAvailable: false,
    desktopManaged: true,
    approvedRoots: [{ rootId: "root-1", label: "code", path: "/Users/owner/code" }],
  };
}

function loopbackStatus() {
  return {
    ...trustedProxyStatus(),
    enabled: false,
    reachability: "loopback-only",
    pairingBaseUrl: null,
    pairingBlockedReason: "Set a system-trusted HTTPS endpoint before pairing a device.",
    approvedRoots: [],
  };
}

function emptyAccess() {
  return { pairingLinks: [], clientSessions: [] };
}

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MobileAccessSettingsPanel active />
    </QueryClientProvider>,
  );
}

function setDesktopBridge(bridge: unknown): void {
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: bridge,
    writable: true,
  });
}

describe("MobileAccessSettingsPanel", () => {
  beforeEach(() => {
    harness.getStatus.mockReset().mockResolvedValue(trustedProxyStatus());
    harness.listAccess.mockReset().mockResolvedValue(emptyAccess());
    harness.createPairingCredential.mockReset();
    harness.revokePairingLink.mockReset().mockResolvedValue({ revoked: true });
    harness.revokeClientSession.mockReset().mockResolvedValue({ revoked: true });
    harness.copyTextToClipboard.mockReset().mockResolvedValue(undefined);
    harness.toastAdd.mockReset();
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "desktopBridge");
    document.body.innerHTML = "";
  });

  it("creates a mobile-audience pairing code and keeps the credential out of the DOM text", async () => {
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    harness.createPairingCredential.mockResolvedValue({
      id: "link-1",
      credential: CREDENTIAL,
      credentialHint: "pair-se",
      audience: "mobile-v1",
      label: "Owner phone",
      expiresAt,
    });
    await renderPanel();

    const deviceName = page.getByRole("textbox", { name: "Device name" });
    await deviceName.fill("Owner phone");
    await page.getByRole("button", { name: "Create pairing code" }).click();
    await vi.waitFor(() => expect(harness.createPairingCredential).toHaveBeenCalledOnce());

    expect(harness.createPairingCredential.mock.calls[0]?.[0]).toEqual({
      audience: "mobile-v1",
      label: "Owner phone",
    });

    await vi.waitFor(() =>
      expect(page.getByRole("img", { name: "Pairing QR code" }).element()).toBeTruthy(),
    );
    expect(document.body.textContent).toContain("Expires in");

    // The credential and the link that carries it must never be readable text.
    expect(document.body.textContent).not.toContain(CREDENTIAL);
    expect(document.body.textContent).not.toContain("synara://pair");
    expect(document.body.innerHTML).not.toContain(CREDENTIAL);

    await page.getByRole("button", { name: "Copy link" }).click();
    await vi.waitFor(() => expect(harness.copyTextToClipboard).toHaveBeenCalledOnce());
    const copied = String(harness.copyTextToClipboard.mock.calls[0]?.[0]);
    expect(copied.startsWith("synara://pair#")).toBe(true);
    const decoded = decodeMobilePairingDeepLink(copied);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.payload).toEqual({
        version: 1,
        baseUrl: "https://mac.tail1234.ts.net",
        environmentId: "env-local",
        credential: CREDENTIAL,
        expiresAt,
      });
    }

    await page.getByRole("button", { name: "Dismiss" }).click();
    await vi.waitFor(() =>
      expect(page.getByRole("img", { name: "Pairing QR code" }).elements()).toHaveLength(0),
    );
  });

  it("drops the pairing code once it expires", async () => {
    harness.createPairingCredential.mockResolvedValue({
      id: "link-expiring",
      credential: CREDENTIAL,
      credentialHint: "pair-se",
      audience: "mobile-v1",
      expiresAt: new Date(Date.now() + 1_200).toISOString(),
    });
    await renderPanel();

    await page.getByRole("button", { name: "Create pairing code" }).click();
    await vi.waitFor(() =>
      expect(page.getByRole("img", { name: "Pairing QR code" }).element()).toBeTruthy(),
    );
    await vi.waitFor(
      () => expect(page.getByRole("img", { name: "Pairing QR code" }).elements()).toHaveLength(0),
      { timeout: 5_000 },
    );
  });

  it("blocks pairing when the server is only reachable on loopback", async () => {
    harness.getStatus.mockResolvedValue(loopbackStatus());
    await renderPanel();

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        "Loopback only. No device outside this Mac can reach Synara.",
      ),
    );
    expect(document.body.textContent).toContain(
      "Set a system-trusted HTTPS endpoint before pairing a device.",
    );
    const create = page.getByRole("button", { name: "Create pairing code" });
    await vi.waitFor(() => expect((create.element() as HTMLButtonElement).disabled).toBe(true));
    expect(harness.createPairingCredential).not.toHaveBeenCalled();
  });

  it("labels a private-LAN endpoint as insecure development access", async () => {
    harness.getStatus.mockResolvedValue({
      ...trustedProxyStatus(),
      mode: "private-lan",
      reachability: "private-lan-insecure",
      pairingBaseUrl: "http://192.168.1.24:4317",
      insecureDevelopmentAccess: true,
      privateLanAvailable: true,
    });
    harness.createPairingCredential.mockResolvedValue({
      id: "link-lan",
      credential: CREDENTIAL,
      credentialHint: "pair-se",
      audience: "mobile-v1",
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    await renderPanel();

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Insecure development access:"),
    );
    await page.getByRole("button", { name: "Create pairing code" }).click();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        "Insecure development access — this code pairs over plain HTTP.",
      ),
    );
  });

  it("surfaces a non-owner rejection instead of the pairing controls", async () => {
    harness.getStatus.mockRejectedValue(
      new Error("Owner authorization is required for this operation."),
    );
    await renderPanel();

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        "Owner authorization is required for this operation.",
      ),
    );
    expect(
      (page.getByRole("button", { name: "Create pairing code" }).element() as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("lists pending links by hint and revokes links and paired devices", async () => {
    harness.listAccess.mockResolvedValue({
      pairingLinks: [
        {
          id: "link-1",
          credentialHint: "pair-se",
          audience: "mobile-v1",
          role: "client",
          subject: "one-time-token",
          label: "Spare phone",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        {
          id: "link-browser",
          credentialHint: "brow-se",
          audience: "interactive",
          role: "client",
          subject: "one-time-token",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
      clientSessions: [
        {
          sessionId: "session-1",
          subject: "mobile",
          role: "client",
          audience: "mobile-v1",
          method: "bearer-session-token",
          client: { label: "Owner phone", deviceType: "mobile" },
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          lastConnectedAt: null,
          connected: true,
          current: false,
        },
      ],
    });
    await renderPanel();

    await vi.waitFor(() => expect(document.body.textContent).toContain("Spare phone"));
    expect(document.body.textContent).toContain("Code pair-se");
    // Interactive-audience links belong to the browser pairing surface, not here.
    expect(document.body.textContent).not.toContain("brow-se");

    await page.getByRole("button", { name: "Revoke" }).click();
    await vi.waitFor(() =>
      expect(harness.revokePairingLink).toHaveBeenCalledWith({ id: "link-1" }),
    );

    await page.getByRole("button", { name: "Disconnect" }).click();
    await vi.waitFor(() =>
      expect(harness.revokeClientSession).toHaveBeenCalledWith({ sessionId: "session-1" }),
    );
  });

  it("drives the desktop bridge for enable/disable and approved roots", async () => {
    const config = {
      enabled: false,
      mode: "trusted-proxy" as const,
      publicBaseUrl: "https://mac.tail1234.ts.net",
      approvedRoots: ["/Users/owner/code"],
    };
    const apply = vi.fn((next: unknown) => Promise.resolve({ config: next, restarted: true }));
    const pickRoot = vi.fn(() => Promise.resolve("/Users/owner/other"));
    setDesktopBridge({
      mobileAccess: {
        read: () =>
          Promise.resolve({ config, privateLanAvailable: false, configPath: "/tmp/cfg.json" }),
        apply,
        pickRoot,
      },
    });
    await renderPanel();

    await vi.waitFor(() =>
      expect(page.getByRole("button", { name: "Turn on" }).element()).toBeTruthy(),
    );
    await page.getByRole("button", { name: "Turn on" }).click();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledWith({ ...config, enabled: true }));

    await page.getByRole("button", { name: "Add folder" }).click();
    await vi.waitFor(() => expect(pickRoot).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(apply).toHaveBeenLastCalledWith(
        expect.objectContaining({
          approvedRoots: ["/Users/owner/code", "/Users/owner/other"],
        }),
      ),
    );
  });

  it("falls back to read-only CLI guidance without a desktop bridge", async () => {
    await renderPanel();

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("SYNARA_MOBILE_ACCESS_CONFIG"),
    );
    expect(page.getByRole("button", { name: "Add folder" }).elements()).toHaveLength(0);
    expect(page.getByRole("button", { name: "Turn on" }).elements()).toHaveLength(0);
  });

  it("uses the shared disclosure motion for the limitations toggle", async () => {
    await renderPanel();

    const details = page.getByRole("button", { name: "Details" });
    expect(details.element().getAttribute("aria-expanded")).toBe("false");
    const shell = details
      .element()
      .closest("[data-slot='settings-row']")
      ?.querySelector("div[inert]");
    expect(shell?.className).toContain("duration-220");
    await details.click();
    await vi.waitFor(() => expect(details.element().getAttribute("aria-expanded")).toBe("true"));
    expect(document.body.textContent).toContain("This Mac has to be awake and reachable.");
  });
});
