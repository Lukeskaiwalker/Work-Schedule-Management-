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
 * - iOS Safari only supports Web Push for PWAs installed to the Home Screen.
 *   When the app is running in a regular Safari tab on iOS we report
 *   "requires-pwa" so the UI can show the appropriate install instructions
 *   instead of a misleading "check browser settings" message.
 */
import { useState, useCallback } from "react";

export type BrowserNotifPermission =
  | "default"
  | "granted"
  | "denied"
  | "unsupported"
  | "requires-pwa";

/** True when the app is running as an installed PWA (any platform). */
function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as { standalone?: boolean }).standalone === true
  );
}

/** True when running inside iOS Safari (not Chrome/Firefox for iOS). */
function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  return (
    /iP(hone|od|ad)/i.test(ua) &&
    /WebKit/i.test(ua) &&
    !/(CriOS|FxiOS|OPiOS|mercury)/i.test(ua)
  );
}

function getInitialPermission(): BrowserNotifPermission {
  if (typeof Notification === "undefined") return "unsupported";
  // iOS Safari in a regular browser tab can never show notifications —
  // report a dedicated state so the UI can guide the user to install the PWA.
  if (isIosSafari() && !isStandalone()) return "requires-pwa";
  return Notification.permission as BrowserNotifPermission;
}

export function useBrowserNotifications() {
  const [permission, setPermission] = useState<BrowserNotifPermission>(getInitialPermission);

  const supported =
    permission !== "unsupported" && permission !== "requires-pwa";

  const requestPermission = useCallback(async () => {
    if (typeof Notification === "undefined") return;
    if (isIosSafari() && !isStandalone()) return; // can't prompt from browser tab
    const result = await Notification.requestPermission();
    setPermission(result as BrowserNotifPermission);
  }, []);

  const showNotification = useCallback(
    (title: string, options?: NotificationOptions) => {
      if (typeof Notification === "undefined") return;
      if (Notification.permission !== "granted") return;
      // Skip if the user is actively looking at the tab.
      if (document.visibilityState === "visible") return;
      try {
        new Notification(title, options);
      } catch {
        // Graceful degradation — some environments block even granted notifications.
      }
    },
    [],
  );

  return { permission, supported, requestPermission, showNotification };
}
