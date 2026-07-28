// FILE: MobileAccessSettingsPanel.tsx
// Purpose: Owner surface for pairing the Synara iOS app and scoping what it may reach.
// Layer: Settings UI components
// Exports: MobileAccessSettingsPanel
//
// Secret handling: the raw pairing credential lives only in this component's
// state until it expires or is dismissed, reaches the DOM only inside the QR /
// copy affordance, and is never logged.

import {
  MOBILE_AUTH_AUDIENCE,
  MOBILE_PAIRING_PAYLOAD_VERSION,
  type AuthClientSession,
  type AuthPairingLink,
  type MobileAccessConfig,
  type MobileAccessStatus,
} from "@synara/contracts";
import { encodeMobilePairingDeepLink } from "@synara/shared/mobilePairing";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { Input } from "~/components/ui/input";
import { toastManager } from "~/components/ui/toast";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { encodeQrCode, qrCodeToSvgPath } from "~/lib/qrCode";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { SettingsListRow, SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

const STATUS_QUERY_KEY = ["server", "mobileAccessStatus"] as const;
const ACCESS_QUERY_KEY = ["server", "mobileAccessSessions"] as const;
const DEFAULT_DEVICE_LABEL = "iPhone";

const REACHABILITY_SUMMARY: Record<MobileAccessStatus["reachability"], string> = {
  disabled: "Loopback only. Mobile access is turned off.",
  "loopback-only": "Loopback only. No device outside this Mac can reach Synara.",
  "trusted-proxy": "Reachable through your system-trusted HTTPS endpoint.",
  "private-lan-insecure": "Reachable on the local network without TLS (development build only).",
};

/**
 * Auth listings type their timestamps as `DateTime.Utc`, but the WebSocket
 * transport hands back the JSON encoding, so accept either shape.
 */
function toIsoString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && value !== null && "epochMillis" in value) {
    const epochMillis = Number((value as { epochMillis: unknown }).epochMillis);
    if (Number.isFinite(epochMillis)) return new Date(epochMillis).toISOString();
  }
  return String(value);
}

function formatDateTime(value: unknown): string {
  const milliseconds = Date.parse(toIsoString(value));
  return Number.isNaN(milliseconds) ? "Unknown" : new Date(milliseconds).toLocaleString();
}

function formatCountdown(expiresAt: string, nowMs: number): string {
  const remainingMs = Date.parse(expiresAt) - nowMs;
  if (Number.isNaN(remainingMs)) return "an unknown amount of time";
  if (remainingMs <= 0) return "0s";
  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function copyWithToast(value: string, title: string): void {
  void copyTextToClipboard(value).then(
    () => toastManager.add({ type: "success", title }),
    (error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not copy",
        description: error instanceof Error ? error.message : "Clipboard access failed.",
      }),
  );
}

function rootDisplayName(rootPath: string): string {
  const trimmed = rootPath.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || rootPath;
}

function reportError(title: string, error: unknown): void {
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "Unexpected error.",
  });
}

/** Renders the deep link as an inline SVG; the link never leaves this element. */
function PairingQrCode(props: { readonly value: string; readonly insecure: boolean }) {
  const matrix = useMemo(() => {
    try {
      return encodeQrCode(props.value, { minEcc: "M" });
    } catch {
      return null;
    }
  }, [props.value]);

  if (!matrix) {
    return (
      <div className="text-[11px] text-destructive">
        This pairing link is too long to encode as a QR code. Use the copy fallback instead.
      </div>
    );
  }
  const quietZone = 4;
  const span = matrix.size + quietZone * 2;
  return (
    <svg
      role="img"
      aria-label="Pairing QR code"
      viewBox={`0 0 ${span} ${span}`}
      className={cn(
        "size-44 shrink-0 rounded-lg bg-white p-1",
        props.insecure && "ring-2 ring-destructive/70",
      )}
      shapeRendering="crispEdges"
    >
      <path
        d={qrCodeToSvgPath(matrix)}
        fill="#000"
        transform={`translate(${quietZone} ${quietZone})`}
      />
    </svg>
  );
}

interface ActivePairing {
  readonly id: string;
  readonly deepLink: string;
  readonly expiresAt: string;
  readonly insecure: boolean;
}

export function MobileAccessSettingsPanel(props: { active: boolean }) {
  const queryClient = useQueryClient();
  const [deviceLabel, setDeviceLabel] = useState(DEFAULT_DEVICE_LABEL);
  const [activePairing, setActivePairing] = useState<ActivePairing | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [limitationsOpen, setLimitationsOpen] = useState(false);
  const [desktopConfig, setDesktopConfig] = useState<MobileAccessConfig | null>(null);
  const [applying, setApplying] = useState(false);
  const [publicBaseUrlDraft, setPublicBaseUrlDraft] = useState("");

  const mobileAccessBridge =
    typeof window === "undefined" ? undefined : window.desktopBridge?.mobileAccess;

  const statusQuery = useQuery({
    queryKey: STATUS_QUERY_KEY,
    queryFn: () => ensureNativeApi().server.mobileAccess.getStatus(),
    enabled: props.active,
    staleTime: 5_000,
  });
  const accessQuery = useQuery({
    queryKey: ACCESS_QUERY_KEY,
    queryFn: () => ensureNativeApi().server.mobileAccess.listAccess(),
    enabled: props.active,
    staleTime: 5_000,
  });

  useEffect(() => {
    if (!props.active || !mobileAccessBridge) return;
    void mobileAccessBridge.read().then(
      (state) => {
        setDesktopConfig(state.config);
        setPublicBaseUrlDraft(state.config.publicBaseUrl ?? "");
      },
      (error: unknown) => reportError("Could not read mobile access settings", error),
    );
  }, [mobileAccessBridge, props.active]);

  // One ticker drives every countdown; expiry drops the credential from state.
  useEffect(() => {
    if (!props.active) return;
    const interval = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, [props.active]);

  useEffect(() => {
    if (activePairing && Date.parse(activePairing.expiresAt) <= nowMs) setActivePairing(null);
  }, [activePairing, nowMs]);

  const status = statusQuery.data;
  const accessSnapshot = accessQuery.data;
  const mobilePairingLinks = useMemo(
    () =>
      (accessSnapshot?.pairingLinks ?? []).filter((link) => link.audience === MOBILE_AUTH_AUDIENCE),
    [accessSnapshot],
  );
  const mobileClientSessions = useMemo(
    () =>
      (accessSnapshot?.clientSessions ?? []).filter(
        (session) => session.audience === MOBILE_AUTH_AUDIENCE,
      ),
    [accessSnapshot],
  );

  const canCreatePairing = (status?.pairingBaseUrl ?? null) !== null;

  const refreshAccess = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ACCESS_QUERY_KEY });
  }, [queryClient]);

  const createPairing = useMutation({
    mutationFn: async (): Promise<ActivePairing> => {
      if (!status || status.pairingBaseUrl === null) {
        throw new Error(status?.pairingBlockedReason ?? "Mobile access is not reachable yet.");
      }
      const label = deviceLabel.trim();
      const issued = await ensureNativeApi().server.mobileAccess.createPairingCredential({
        audience: MOBILE_AUTH_AUDIENCE,
        ...(label.length > 0 ? { label } : {}),
      });
      const expiresAt = toIsoString(issued.expiresAt);
      return {
        id: issued.id,
        deepLink: encodeMobilePairingDeepLink({
          version: MOBILE_PAIRING_PAYLOAD_VERSION,
          baseUrl: status.pairingBaseUrl,
          environmentId: status.environmentId,
          credential: issued.credential,
          expiresAt,
        }),
        expiresAt,
        insecure: status.insecureDevelopmentAccess,
      };
    },
    onSuccess: (pairing) => {
      setActivePairing(pairing);
      refreshAccess();
    },
    onError: (error: unknown) => reportError("Could not create pairing code", error),
  });

  const revokeLink = useMutation({
    mutationFn: (id: string) => ensureNativeApi().server.mobileAccess.revokePairingLink({ id }),
    onSuccess: (_result, id) => {
      if (activePairing?.id === id) setActivePairing(null);
      refreshAccess();
      toastManager.add({ type: "success", title: "Pairing link revoked" });
    },
    onError: (error: unknown) => reportError("Could not revoke pairing link", error),
  });

  const revokeSession = useMutation({
    mutationFn: (sessionId: AuthClientSession["sessionId"]) =>
      ensureNativeApi().server.mobileAccess.revokeClientSession({ sessionId }),
    onSuccess: () => {
      refreshAccess();
      toastManager.add({ type: "success", title: "Device disconnected" });
    },
    onError: (error: unknown) => reportError("Could not disconnect device", error),
  });

  const applyDesktopConfig = useCallback(
    async (next: MobileAccessConfig) => {
      if (!mobileAccessBridge) return;
      setApplying(true);
      setActivePairing(null);
      try {
        const result = await mobileAccessBridge.apply(next);
        setDesktopConfig(result.config);
        setPublicBaseUrlDraft(result.config.publicBaseUrl ?? "");
        if (result.error) {
          reportError("Synara could not restart", new Error(result.error));
        } else {
          toastManager.add({
            type: "success",
            title: "Mobile access updated",
            description: "Synara's local server restarted with the new settings.",
          });
        }
        await queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
      } catch (error) {
        reportError("Could not update mobile access", error);
      } finally {
        setApplying(false);
      }
    },
    [mobileAccessBridge, queryClient],
  );

  const addRoot = useCallback(async () => {
    if (!mobileAccessBridge || !desktopConfig) return;
    const picked = await mobileAccessBridge.pickRoot().catch((error: unknown) => {
      reportError("Could not choose a folder", error);
      return null;
    });
    if (picked === null || desktopConfig.approvedRoots.includes(picked)) return;
    await applyDesktopConfig({
      ...desktopConfig,
      approvedRoots: [...desktopConfig.approvedRoots, picked],
    });
  }, [applyDesktopConfig, desktopConfig, mobileAccessBridge]);

  const removeRoot = useCallback(
    async (rootPath: string) => {
      if (!desktopConfig) return;
      await applyDesktopConfig({
        ...desktopConfig,
        approvedRoots: desktopConfig.approvedRoots.filter((entry) => entry !== rootPath),
      });
    },
    [applyDesktopConfig, desktopConfig],
  );

  if (!props.active) return null;

  const approvedRoots =
    desktopConfig?.approvedRoots ?? status?.approvedRoots.map((root) => root.path) ?? [];

  return (
    <div className="space-y-6">
      <SettingsSection title="Reachability">
        <SettingsRow
          title="Status"
          description="The Synara iOS app connects straight to this Mac. Nothing is relayed through a Synara server."
          status={
            status ? (
              <>
                <span className="block">{REACHABILITY_SUMMARY[status.reachability]}</span>
                {status.pairingBaseUrl !== null ? (
                  <span className="mt-1 block break-all font-mono text-[11px] text-foreground">
                    {status.pairingBaseUrl}
                  </span>
                ) : status.pairingBlockedReason !== null ? (
                  <span className="mt-1 block text-destructive">{status.pairingBlockedReason}</span>
                ) : null}
                {status.insecureDevelopmentAccess ? (
                  <span className="mt-1 block font-medium text-destructive">
                    Insecure development access: this endpoint has no TLS. Never use it outside a
                    network you trust.
                  </span>
                ) : null}
              </>
            ) : statusQuery.isError ? (
              <span className="text-destructive">
                {statusQuery.error instanceof Error
                  ? statusQuery.error.message
                  : "Only the owner session can manage mobile access."}
              </span>
            ) : (
              "Checking how this Mac is reachable…"
            )
          }
        />

        {mobileAccessBridge && desktopConfig ? (
          <>
            <SettingsRow
              title="Published HTTPS endpoint"
              description="The exact address your proxy serves, such as a Tailscale Serve hostname. Synara's own listener stays on 127.0.0.1."
              control={
                <Button
                  size="xs"
                  variant="outline"
                  disabled={applying}
                  onClick={() =>
                    void applyDesktopConfig({
                      ...desktopConfig,
                      mode: "trusted-proxy",
                      publicBaseUrl: publicBaseUrlDraft.trim(),
                    })
                  }
                >
                  {applying ? "Applying…" : "Save and restart"}
                </Button>
              }
            >
              <Input
                className="mt-3"
                aria-label="Published HTTPS endpoint"
                placeholder="https://mac.tail1234.ts.net"
                value={publicBaseUrlDraft}
                onChange={(event) => setPublicBaseUrlDraft(event.target.value)}
              />
            </SettingsRow>
            <SettingsRow
              title="Mobile access"
              description="When off, Synara stays loopback-only and no pairing code can be created."
              control={
                <Button
                  size="xs"
                  variant={desktopConfig.enabled ? "destructive-outline" : "outline"}
                  disabled={applying}
                  onClick={() =>
                    void applyDesktopConfig({ ...desktopConfig, enabled: !desktopConfig.enabled })
                  }
                >
                  {desktopConfig.enabled ? "Turn off" : "Turn on"}
                </Button>
              }
            />
          </>
        ) : (
          <SettingsRow
            title="Configuration"
            description="Mobile access is configured on disk when Synara runs outside the desktop app."
            status={
              <span className="block">
                Start the server with{" "}
                <code className="font-mono text-[11px] text-foreground">
                  SYNARA_MOBILE_ACCESS_CONFIG=/path/to/mobile-access.json
                </code>
                , then set{" "}
                <code className="font-mono text-[11px] text-foreground">publicBaseUrl</code> to your
                HTTPS endpoint and list the folders the app may reach in{" "}
                <code className="font-mono text-[11px] text-foreground">approvedRoots</code>.
              </span>
            }
          />
        )}
      </SettingsSection>

      <SettingsSection title="Pair a device">
        <SettingsRow
          title="New pairing code"
          description="Creates a short-lived code for one device. Scan it with the Synara iOS app."
          status={
            canCreatePairing
              ? "The code expires shortly after it is created."
              : (status?.pairingBlockedReason ??
                "Mobile access is not reachable yet, so no pairing code can be created.")
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!canCreatePairing || createPairing.isPending}
              onClick={() => createPairing.mutate()}
            >
              {createPairing.isPending ? "Creating…" : "Create pairing code"}
            </Button>
          }
        >
          <Input
            className="mt-3"
            aria-label="Device name"
            placeholder={DEFAULT_DEVICE_LABEL}
            value={deviceLabel}
            onChange={(event) => setDeviceLabel(event.target.value)}
          />
          {activePairing ? (
            <div className="mt-3 flex flex-col gap-3 rounded-lg border border-border/70 p-3 sm:flex-row sm:items-center">
              <PairingQrCode value={activePairing.deepLink} insecure={activePairing.insecure} />
              <div className="min-w-0 flex-1 space-y-2 text-[11px] text-muted-foreground">
                {activePairing.insecure ? (
                  <div className="font-medium text-destructive">
                    Insecure development access — this code pairs over plain HTTP.
                  </div>
                ) : null}
                <div>Expires in {formatCountdown(activePairing.expiresAt, nowMs)}.</div>
                <div className="flex gap-2">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => copyWithToast(activePairing.deepLink, "Pairing link copied")}
                  >
                    Copy link
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setActivePairing(null)}>
                    Dismiss
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Pending pairing links">
        {mobilePairingLinks.length === 0 ? (
          <SettingsRow
            title="No pending links"
            description="Pairing links disappear once they are used or expire."
          />
        ) : (
          mobilePairingLinks.map((link: AuthPairingLink) => (
            <SettingsListRow
              key={link.id}
              title={link.label ?? "Unlabelled device"}
              description={`Code ${link.credentialHint}… · expires ${formatDateTime(link.expiresAt)}`}
              actions={
                <Button
                  size="xs"
                  variant="destructive-outline"
                  disabled={revokeLink.isPending}
                  onClick={() => revokeLink.mutate(link.id)}
                >
                  Revoke
                </Button>
              }
            />
          ))
        )}
      </SettingsSection>

      <SettingsSection title="Paired devices">
        {mobileClientSessions.length === 0 ? (
          <SettingsRow
            title="No paired devices"
            description="Devices appear here once they finish pairing."
          />
        ) : (
          mobileClientSessions.map((session) => (
            <SettingsListRow
              key={session.sessionId}
              title={session.client.label ?? session.subject}
              description={`${session.connected ? "Connected" : "Idle"} · expires ${formatDateTime(session.expiresAt)}`}
              actions={
                <Button
                  size="xs"
                  variant="destructive-outline"
                  disabled={revokeSession.isPending}
                  onClick={() => revokeSession.mutate(session.sessionId)}
                >
                  Disconnect
                </Button>
              }
            />
          ))
        )}
      </SettingsSection>

      <SettingsSection title="Approved folders">
        <SettingsRow
          title="Folders the app may reach"
          description="The iOS app can only open projects inside these folders."
          control={
            mobileAccessBridge ? (
              <Button
                size="xs"
                variant="outline"
                disabled={applying}
                onClick={() => void addRoot()}
              >
                Add folder
              </Button>
            ) : undefined
          }
        />
        {approvedRoots.length === 0 ? (
          <SettingsRow
            title="No folders approved"
            description="Until you approve a folder, the app can browse nothing."
          />
        ) : (
          approvedRoots.map((rootPath) => (
            <SettingsListRow
              key={rootPath}
              title={rootDisplayName(rootPath)}
              description={rootPath}
              actions={
                mobileAccessBridge ? (
                  <Button
                    size="xs"
                    variant="destructive-outline"
                    disabled={applying}
                    onClick={() => void removeRoot(rootPath)}
                  >
                    Remove
                  </Button>
                ) : undefined
              }
            />
          ))
        )}
      </SettingsSection>

      <SettingsSection title="What to expect">
        <SettingsRow
          title="Limitations"
          description="Mobile access talks to this Mac, so it inherits the Mac's availability."
          control={
            <Button
              size="xs"
              variant="ghost"
              aria-expanded={limitationsOpen}
              onClick={() => setLimitationsOpen((current) => !current)}
            >
              Details
              <DisclosureChevron open={limitationsOpen} className="ml-1 size-3.5" />
            </Button>
          }
        >
          <DisclosureRegion
            open={limitationsOpen}
            contentClassName="mt-3 space-y-2 rounded-lg border border-border/70 p-3 text-[11px] text-muted-foreground"
          >
            <div>
              This Mac has to be awake and reachable. If it sleeps or leaves the network, the app
              cannot reach your work until it comes back.
            </div>
            <div>
              Sync runs while the app is in the foreground. Backgrounding it pauses live updates
              until you return.
            </div>
          </DisclosureRegion>
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}
