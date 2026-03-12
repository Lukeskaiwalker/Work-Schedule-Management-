/**
 * SMPL Workflow — Service Worker
 *
 * Primary purpose: enable ServiceWorkerRegistration.showNotification() on
 * iOS PWA, where the Notification constructor is blocked by WebKit.
 *
 * Secondary: handle server-side Web Push events (future) and bring the app
 * to the foreground when the user taps a notification.
 */

// Handle push events sent from a server via Web Push API (future use).
self.addEventListener("push", (event) => {
  if (!event.data) return;
  let data = {};
  try { data = event.data.json(); } catch {}
  const title = data.title || "SMPL Workflow";
  const options = {
    body: data.body || "",
    icon: data.icon || "/logo.jpeg",
    badge: "/logo.jpeg",
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Bring the app to focus when the user taps a notification.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (client.url.startsWith(self.location.origin) && "focus" in client) {
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow("/");
        }
      }),
  );
});
