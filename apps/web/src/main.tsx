import React, { Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";

import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { NativeFileViewer } from "./components/shared/NativeFileViewer";
import { NativeServerGate } from "./native/NativeServerGate";
import { installNativeFileOpener } from "./native/fileOpen";
import { installNativeNetworkBridge } from "./native/networkBridge";
import { IS_NATIVE_SHELL } from "./native/shell";
import { chooseShell } from "./portal/shellChoice";
import "./styles.css";

// Two apps share this bundle: the office app and the partner portal for
// subcontractors' logins. Which one boots is decided before either mounts —
// the office app starts loading everything the moment it has a session, and
// the server refuses all of it to a partner login. Both are code-split, so a
// partner's phone never downloads the office app and the office never waits
// for the portal.
const App = lazy(() => import("./App").then((m) => ({ default: m.App })));
const PortalApp = lazy(() => import("./portal/PortalApp").then((m) => ({ default: m.PortalApp })));

function storedToken(): string | null {
  try {
    return localStorage.getItem("smpl_token");
  } catch {
    return null;
  }
}

function Root() {
  const shell = chooseShell(window.location.pathname, storedToken());
  return (
    <Suspense fallback={<div className="page-loading-spinner" aria-hidden="true" />}>
      {shell === "portal" ? <PortalApp /> : <App />}
    </Suspense>
  );
}

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
        <Root />
        {/* Renders null until an /api file link is clicked, and null always in
            a browser. Mounted here so App.tsx stays untouched. */}
        <NativeFileViewer />
      </NativeServerGate>
    </AppErrorBoundary>
  </React.StrictMode>,
);
