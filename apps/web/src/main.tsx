import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { NativeServerGate } from "./native/NativeServerGate";
import { installNativeNetworkBridge } from "./native/networkBridge";
import { IS_NATIVE_SHELL } from "./native/shell";
import "./styles.css";

// Must run before any component can issue a request: in the native shell it is
// what makes "/api/..." resolve to the server instead of to the app bundle.
// No-op in a browser.
installNativeNetworkBridge();

// Register the service worker so that ServiceWorkerRegistration.showNotification()
// is available — required for iOS PWA notifications (new Notification() is blocked).
//
// Skipped in the native shell: WebKit does not run service workers on custom
// schemes, so registration from capacitor://localhost can only ever fail, and
// the shell has real notification APIs available to it instead.
if (!IS_NATIVE_SHELL && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // SW registration is best-effort; the app works without it.
    });
  });
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <NativeServerGate>
        <App />
      </NativeServerGate>
    </AppErrorBoundary>
  </React.StrictMode>,
);
