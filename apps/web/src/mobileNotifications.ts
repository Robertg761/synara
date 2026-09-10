// Native presentation only. Event detection and notification copy are shared with desktop.

import { getShellServerWsUrl } from "./shellSession";

let permission: NotificationPermission = "default";
const CHANNEL_ID = "synara-activity";

function rememberPermission(value: string): NotificationPermission {
  permission = value === "granted" ? "granted" : value === "denied" ? "denied" : "default";
  window.dispatchEvent(new Event("synara:notification-permission"));
  return permission;
}

export function readMobileNotificationPermission(): NotificationPermission {
  return permission;
}

export async function refreshMobileNotificationPermission(): Promise<NotificationPermission> {
  const { LocalNotifications } = await import("@capacitor/local-notifications");
  return rememberPermission((await LocalNotifications.checkPermissions()).display);
}

export async function requestMobileNotificationPermission(): Promise<NotificationPermission> {
  const { LocalNotifications } = await import("@capacitor/local-notifications");
  return rememberPermission((await LocalNotifications.requestPermissions()).display);
}

export function mobileNotificationId(key: string): number {
  let hash = 0;
  for (const char of key) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0;
  return (hash & 0x7fffffff) || 1;
}

export async function showMobileNotification(input: {
  readonly title: string;
  readonly body: string;
  readonly threadId?: string;
}): Promise<boolean> {
  const { LocalNotifications } = await import("@capacitor/local-notifications");
  if (await refreshMobileNotificationPermission() !== "granted") return false;
  await LocalNotifications.createChannel({
    id: CHANNEL_ID,
    name: "Chat activity",
    description: "Chats and terminal agents that finish or need input.",
    importance: 4,
    visibility: 0,
  });
  await LocalNotifications.schedule({
    notifications: [{
      id: mobileNotificationId(input.threadId ?? "synara:test"),
      title: input.title,
      body: input.body,
      channelId: CHANNEL_ID,
      // Opt out explicitly: the plugin otherwise prompts for exact-alarm access.
      isExactNotification: false,
      extra: { threadId: input.threadId, server: getShellServerWsUrl() },
    }],
  });
  return true;
}
