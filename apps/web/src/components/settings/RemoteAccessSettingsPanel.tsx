// FILE: RemoteAccessSettingsPanel.tsx
// Purpose: Desktop-managed remote access: enable the LAN/tailnet bind, pair
//          devices with one-time links (QR), and manage connected sessions.
// Layer: Settings UI components

import type {
  AuthClientSession,
  AuthPairingCredentialResult,
  AuthPairingLink,
  DesktopRemoteAccessState,
  DesktopRemoteAccessUrlKind,
} from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { Input } from "~/components/ui/input";
import { QrCode } from "~/components/ui/QrCode";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { makePairingUrl } from "~/lib/pairingUrl";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import {
  SettingsEmptyState,
  SettingsListRow,
  SettingsRow,
  SettingsSection,
  SettingsSectionShell,
  SettingsCard,
} from "./SettingsPanelPrimitives";

const REMOTE_ACCESS_STATE_QUERY_KEY = ["desktop", "remoteAccessState"] as const;
const PAIRING_LINKS_QUERY_KEY = ["server", "authPairingLinks"] as const;
const CLIENT_SESSIONS_QUERY_KEY = ["server", "authClientSessions"] as const;

const URL_KIND_LABELS: Record<DesktopRemoteAccessUrlKind, string> = {
  tailscale: "Tailscale",
  lan: "LAN",
  other: "Other",
};

function remoteAccessBridge() {
  return typeof window === "undefined" ? undefined : window.desktopBridge?.remoteAccess;
}

function dateMillis(value: unknown): number {
  return Date.parse(String(value));
}

function formatDate(value: unknown): string {
  if (value == null) return "Never";
  const milliseconds = dateMillis(value);
  return Number.isNaN(milliseconds) ? String(value) : new Date(milliseconds).toLocaleString();
}

function formatCountdown(expiresAt: unknown, nowMs: number): string {
  const remainingMs = dateMillis(expiresAt) - nowMs;
  if (Number.isNaN(remainingMs) || remainingMs <= 0) return "expired";
  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function describeClient(session: AuthClientSession): string {
  const client = session.client;
  const parts = [client.os, client.browser].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  if (parts.length === 0)
    parts.push(client.deviceType === "unknown" ? "Device" : client.deviceType);
  return parts.join(" · ");
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

export function RemoteAccessSettingsPanel(props: { active: boolean }) {
  const queryClient = useQueryClient();
  const bridge = remoteAccessBridge();
  const [pairingLabel, setPairingLabel] = useState("");
  const [portDraft, setPortDraft] = useState<string | null>(null);
  const [issued, setIssued] = useState<AuthPairingCredentialResult | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!props.active) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [props.active]);

  const stateQuery = useQuery({
    queryKey: REMOTE_ACCESS_STATE_QUERY_KEY,
    queryFn: () => {
      const remoteAccess = remoteAccessBridge();
      if (!remoteAccess) throw new Error("Remote access requires the desktop app.");
      return remoteAccess.getState();
    },
    enabled: props.active && bridge !== undefined,
    staleTime: 5_000,
  });

  useEffect(() => {
    if (!props.active || !bridge) return;
    return bridge.onState((state) => {
      queryClient.setQueryData<DesktopRemoteAccessState>(REMOTE_ACCESS_STATE_QUERY_KEY, state);
    });
  }, [bridge, props.active, queryClient]);

  const state = stateQuery.data ?? null;
  const remoteReady = state?.enabled === true && state.status === "running";

  const pairingLinksQuery = useQuery({
    queryKey: PAIRING_LINKS_QUERY_KEY,
    queryFn: () => ensureNativeApi().server.listAuthPairingLinks(),
    enabled: props.active && remoteReady,
    staleTime: 5_000,
    // Consuming a link on the phone removes it from this list — poll fast
    // while a just-issued link is waiting to be claimed.
    refetchInterval: issued ? 2_000 : 30_000,
  });
  const clientsQuery = useQuery({
    queryKey: CLIENT_SESSIONS_QUERY_KEY,
    queryFn: () => ensureNativeApi().server.listAuthClients(),
    enabled: props.active && remoteReady,
    staleTime: 5_000,
    refetchInterval: issued ? 2_000 : 30_000,
  });

  const setEnabledMutation = useMutation({
    mutationFn: async (input: { enabled: boolean; port?: number }) => {
      const remoteAccess = remoteAccessBridge();
      if (!remoteAccess) throw new Error("Remote access requires the desktop app.");
      const confirmed = await window.desktopBridge?.confirm(
        input.enabled
          ? "Applying this change restarts Synara's background service. Running agent tasks will be interrupted. Continue?"
          : "Disabling remote access restarts Synara's background service and disconnects every remote device. Continue?",
      );
      if (!confirmed) return null;
      return remoteAccess.setEnabled(input);
    },
    onSuccess: (result) => {
      if (!result) return;
      queryClient.setQueryData<DesktopRemoteAccessState>(REMOTE_ACCESS_STATE_QUERY_KEY, result);
      setIssued(null);
      setPortDraft(null);
      void queryClient.invalidateQueries({ queryKey: PAIRING_LINKS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: CLIENT_SESSIONS_QUERY_KEY });
      toastManager.add({
        type: "success",
        title: result.enabled ? "Remote access enabled" : "Remote access disabled",
        description: result.enabled
          ? "Open one of the connection addresses from another device on your network."
          : "Remote devices can no longer connect.",
      });
    },
    onError: (error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not change remote access",
        description: error instanceof Error ? error.message : "The backend restart failed.",
      }),
  });

  const issuePairingMutation = useMutation({
    mutationFn: () => {
      const label = pairingLabel.trim();
      return ensureNativeApi().server.createAuthPairingToken(label ? { label } : undefined);
    },
    onSuccess: (result) => {
      setIssued(result);
      setQrOpen(false);
      void queryClient.invalidateQueries({ queryKey: PAIRING_LINKS_QUERY_KEY });
    },
    onError: (error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not create pairing link",
        description: error instanceof Error ? error.message : "Issuing the credential failed.",
      }),
  });

  const revokePairingMutation = useMutation({
    mutationFn: (id: string) => ensureNativeApi().server.revokeAuthPairingLink({ id }),
    onSuccess: (_result, id) => {
      setIssued((current) => (current?.id === id ? null : current));
      void queryClient.invalidateQueries({ queryKey: PAIRING_LINKS_QUERY_KEY });
    },
    onError: (error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not revoke pairing link",
        description: error instanceof Error ? error.message : "Revocation failed.",
      }),
  });

  const revokeClientMutation = useMutation({
    mutationFn: (sessionId: AuthClientSession["sessionId"]) =>
      ensureNativeApi().server.revokeAuthClient({ sessionId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CLIENT_SESSIONS_QUERY_KEY });
      toastManager.add({
        type: "success",
        title: "Device signed out",
        description: "Its session stops working immediately.",
      });
    },
    onError: (error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not sign out device",
        description: error instanceof Error ? error.message : "Revocation failed.",
      }),
  });

  const revokeOthersMutation = useMutation({
    mutationFn: () => ensureNativeApi().server.revokeOtherAuthClients(),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: CLIENT_SESSIONS_QUERY_KEY });
      toastManager.add({
        type: "success",
        title:
          result.revokedCount === 1
            ? "Signed out 1 device"
            : `Signed out ${result.revokedCount} devices`,
      });
    },
    onError: (error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not sign out devices",
        description: error instanceof Error ? error.message : "Revocation failed.",
      }),
  });

  if (!props.active) return null;

  if (!bridge) {
    return (
      <SettingsSectionShell title="Remote access">
        <SettingsEmptyState>
          Remote access is managed from the Synara desktop app on the machine that runs your agents.
          Open Settings there to enable it or pair another device.
        </SettingsEmptyState>
      </SettingsSectionShell>
    );
  }

  const restarting = state?.status === "restarting" || setEnabledMutation.isPending;
  const primaryUrl = state?.urls[0] ?? null;
  const parsedPortDraft = (() => {
    if (portDraft == null) return null;
    const value = Number(portDraft.trim());
    return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null;
  })();
  const portDraftValid = portDraft == null || parsedPortDraft != null;
  const portDraftUnchanged = portDraft == null || parsedPortDraft === state?.port;
  const issuedExpired = issued ? dateMillis(issued.expiresAt) <= nowMs : false;
  const issuedClaimed =
    issued != null &&
    !issuedExpired &&
    pairingLinksQuery.data != null &&
    !pairingLinksQuery.data.some((link) => link.id === issued.id);
  const issuedPairingUrl =
    issued && primaryUrl ? makePairingUrl(primaryUrl.url, issued.credential) : null;

  return (
    <div className="space-y-6">
      <SettingsSection title="Remote access">
        <SettingsRow
          title="Allow remote connections"
          description="Other devices on your network — a phone on your tailnet, a laptop on your LAN — can open this Synara over HTTP. Traffic is unencrypted on plain LAN; a Tailscale network encrypts it end to end."
          status={
            restarting
              ? "Restarting the background service…"
              : state?.portFallback != null
                ? `Port ${state.port} was busy — this session is using port ${state.portFallback}. Addresses change back after the port frees up.`
                : undefined
          }
          control={
            <Switch
              checked={state?.enabled ?? false}
              disabled={restarting || stateQuery.isLoading}
              onCheckedChange={(enabled) => setEnabledMutation.mutate({ enabled })}
            />
          }
        />
        {state?.enabled ? (
          <SettingsRow
            title="Port"
            description="Remote addresses use this port. Changing it restarts the background service and signs remote devices out until they reopen the new address."
            control={
              <div className="flex w-full items-center gap-2 sm:w-auto">
                <Input
                  className="w-full font-mono sm:w-24"
                  inputMode="numeric"
                  value={portDraft ?? String(state.port)}
                  onChange={(event) => setPortDraft(event.target.value)}
                />
                <Button
                  size="xs"
                  variant="outline"
                  disabled={restarting || !portDraftValid || portDraftUnchanged}
                  onClick={() => {
                    if (parsedPortDraft == null) return;
                    setEnabledMutation.mutate({ enabled: true, port: parsedPortDraft });
                  }}
                >
                  Apply
                </Button>
              </div>
            }
          />
        ) : null}
        {state?.enabled ? (
          state.urls.length > 0 ? (
            state.urls.map((entry) => (
              <SettingsListRow
                key={entry.url}
                title={
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-xs">{entry.url}</span>
                    <span className="rounded border border-border/70 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {URL_KIND_LABELS[entry.kind]}
                    </span>
                  </span>
                }
                description="Open on another device, then pair it with a pairing link below."
                actions={
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => copyWithToast(entry.url, "Address copied")}
                  >
                    Copy
                  </Button>
                }
              />
            ))
          ) : (
            <SettingsListRow
              title="No reachable addresses"
              description="No non-loopback network interface was found. Connect to a network (or start Tailscale) and toggle remote access again."
            />
          )
        ) : null}
      </SettingsSection>

      {remoteReady ? (
        <SettingsSection title="Pair a device">
          <SettingsRow
            title="Create a pairing link"
            description="A one-time link that signs the device in for 30 days. It expires after 5 minutes and can be revoked below until it is used."
            control={
              <div className="flex w-full items-center gap-2 sm:w-auto">
                <Input
                  className="w-full sm:w-44"
                  value={pairingLabel}
                  maxLength={60}
                  placeholder="Label (optional)"
                  onChange={(event) => setPairingLabel(event.target.value)}
                />
                <Button
                  size="sm"
                  disabled={issuePairingMutation.isPending}
                  onClick={() => issuePairingMutation.mutate()}
                >
                  {issuePairingMutation.isPending ? "Creating…" : "Create link"}
                </Button>
              </div>
            }
          />
          {issued && issuedPairingUrl ? (
            <SettingsRow
              title={
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-2 rounded-full",
                      issuedClaimed
                        ? "bg-green-500"
                        : issuedExpired
                          ? "bg-destructive"
                          : "bg-amber-500",
                    )}
                  />
                  {issuedClaimed
                    ? "Device paired"
                    : issuedExpired
                      ? "Pairing link expired"
                      : "Waiting for the device"}
                </span>
              }
              description={
                issuedClaimed
                  ? "The link was used and the device now appears under Connected devices."
                  : issuedExpired
                    ? "The link was not used in time. Create a new one."
                    : "Open this link on the device you are pairing. This page updates automatically once it connects."
              }
              status={
                issuedClaimed || issuedExpired
                  ? undefined
                  : `Expires in ${formatCountdown(issued.expiresAt, nowMs)}.`
              }
              control={
                <div className="flex items-center gap-2">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={issuedExpired || issuedClaimed}
                    onClick={() => copyWithToast(issuedPairingUrl, "Pairing link copied")}
                  >
                    Copy link
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-expanded={qrOpen}
                    disabled={issuedExpired || issuedClaimed}
                    onClick={() => setQrOpen((current) => !current)}
                  >
                    QR code
                    <DisclosureChevron open={qrOpen} className="ml-1 size-3.5" />
                  </Button>
                </div>
              }
            >
              {!issuedClaimed && !issuedExpired ? (
                <>
                  <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-border/70 bg-muted/30 p-3 text-[11px] leading-relaxed">
                    {issuedPairingUrl}
                  </pre>
                  <DisclosureRegion open={qrOpen} contentClassName="mt-3">
                    <div className="flex items-center gap-4">
                      <QrCode value={issuedPairingUrl} label="Pairing link QR code" />
                      <p className="max-w-56 text-[11px] leading-relaxed text-muted-foreground">
                        Scan with the device's camera. Anyone who opens this link before it expires
                        gets access — share it carefully.
                      </p>
                    </div>
                  </DisclosureRegion>
                </>
              ) : null}
            </SettingsRow>
          ) : null}
          {(pairingLinksQuery.data ?? []).map((link: AuthPairingLink) => (
            <SettingsListRow
              key={link.id}
              title={link.label ?? "Pairing link"}
              description={`Created ${formatDate(link.createdAt)} · Expires ${formatDate(link.expiresAt)} · Signs in as ${link.role}`}
              actions={
                <Button
                  size="xs"
                  variant="destructive-outline"
                  disabled={revokePairingMutation.isPending}
                  onClick={() => revokePairingMutation.mutate(link.id)}
                >
                  Revoke
                </Button>
              }
            />
          ))}
        </SettingsSection>
      ) : null}

      {remoteReady ? (
        <SettingsSectionShell
          title="Connected devices"
          action={
            (clientsQuery.data?.filter((session) => !session.current).length ?? 0) > 0 ? (
              <Button
                size="xs"
                variant="outline"
                disabled={revokeOthersMutation.isPending}
                onClick={() => revokeOthersMutation.mutate()}
              >
                Sign out other devices
              </Button>
            ) : undefined
          }
        >
          <SettingsCard>
            {clientsQuery.isLoading ? (
              <SettingsListRow title="Loading devices…" />
            ) : clientsQuery.data?.length ? (
              clientsQuery.data.map((session) => (
                <SettingsListRow
                  key={session.sessionId}
                  align="start"
                  title={
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden="true"
                        className={cn(
                          "size-2 rounded-full",
                          session.connected ? "bg-green-500" : "bg-muted-foreground/40",
                        )}
                      />
                      {describeClient(session)}
                      {session.current ? (
                        <span className="rounded border border-border/70 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                          This device
                        </span>
                      ) : null}
                    </span>
                  }
                  description={
                    <div className="space-y-1">
                      <div>
                        {session.connected ? "Connected now" : "Not connected"} · Role{" "}
                        {session.role}
                        {session.client.ipAddress ? ` · ${session.client.ipAddress}` : ""}
                      </div>
                      <div>
                        Signed in {formatDate(session.issuedAt)} · Last seen{" "}
                        {formatDate(session.lastConnectedAt)} · Expires{" "}
                        {formatDate(session.expiresAt)}
                      </div>
                    </div>
                  }
                  actions={
                    session.current ? null : (
                      <Button
                        size="xs"
                        variant="destructive-outline"
                        disabled={revokeClientMutation.isPending}
                        onClick={() => revokeClientMutation.mutate(session.sessionId)}
                      >
                        Sign out
                      </Button>
                    )
                  }
                />
              ))
            ) : (
              <SettingsListRow
                title="No connected devices"
                description="Devices appear here after they use a pairing link."
              />
            )}
          </SettingsCard>
        </SettingsSectionShell>
      ) : null}
    </div>
  );
}
