/**
 * useBrowserNotifications — thin wrapper around the browser Notification API.
 *
 * Design notes:
 * - `showNotification` is a no-op when the tab is already visible (document is
 *   focused), permission is not "granted", or the API is not supported.
 * - `requestPermission` must be called from a user-gesture handler (button click)
 *   because browsers block programmatic permission prompts.
 * - Permission state is tracked in React state so the UI re-renders when it
 *   changes without requiring a page reload.
 */
import { useState, useCallback } from "react";

export type BrowserNotifPermission = "default" | "granted" | "denied" | "unsupported";

export function useBrowserNotifications() {
  const supported = typeof Notification !== "undefined";

  const [permission, setPermission] = useState<BrowserNotifPermission>(() => {
    if (!supported) return "unsupported";
    return Notification.permission as BrowserNotifPermission;
  });

  const requestPermission = useCallback(async () => {
    if (!supported) return;
    const result = await Notification.requestPermission();
    setPermission(result as BrowserNotifPermission);
  }, [supported]);

  const showNotification = useCallback(
    (title: string, options?: NotificationOptions) => {
      if (!supported || Notification.permission !== "granted") return;
      // Skip if the user is actively looking at the tab.
      if (document.visibilityState === "visible") return;
      try {
        new Notification(title, options);
      } catch {
        // Graceful degradation — some environments block even granted notifications.
      }
    },
    [supported],
  );

  return { permission, supported, requestPermission, showNotification };
}
