import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { NativeFileViewer } from "./components/shared/NativeFileViewer";
import { NativeServerGate } from "./native/NativeServerGate";
import { installNativeFileOpener } from "./native/fileOpen";
import { installNativeNetworkBridge } from "./native/networkBridge";
import { IS_NATIVE_SHELL } from "./native/shell";
import "./styles.css";

// Must run before any component can issue a request: in the native shell it is
// what makes "/api/..." resolve to the server instead of to the app bundle.
// No-op in a browser.
installNativeNetworkBridge();

// Catches clicks on /api file links, which WKWebView would otherwise hand to
// the system browser — where they arrive without a token and 401. No-op in a
// browser, where the same links open a tab and work.
installNativeFileOpener();

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
        {/* Renders null until an /api file link is clicked, and null always in
            a browser. Mounted here so App.tsx stays untouched. */}
        <NativeFileViewer />
      </NativeServerGate>
    </AppErrorBoundary>
  </React.StrictMode>,
);
