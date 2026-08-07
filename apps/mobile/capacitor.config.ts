import type { CapacitorConfig } from "@capacitor/cli";
import { KeyboardResize } from "@capacitor/keyboard";

/**
 * Native iOS shell for the SMPL Workflow SPA.
 *
 * The web assets are BUNDLED (webDir) rather than loaded from the server. That
 * is deliberate:
 *
 *   - `capacitor://localhost` is a secure context, so `getUserMedia` works and
 *     the Werkstatt barcode scanner runs even when the server itself is plain
 *     http on the LAN. Pointing the WebView at the server instead would put us
 *     back in an insecure origin and keep the camera blocked.
 *   - The app shell launches without waiting on the network.
 *
 * The trade-off is that `/api` no longer resolves to the server, which is what
 * `apps/web/src/native/` exists to fix.
 */
const config: CapacitorConfig = {
  appId: "de.smpl.workflow",
  appName: "SMPL",
  // Built by `npm run build:web`; kept out of apps/web/package.json so the
  // production web image never pulls Capacitor or an Xcode project into its
  // build context.
  webDir: "../web/dist",

  ios: {
    // The SPA already positions itself with env(safe-area-inset-*) in nine
    // places (bottom nav, toasts, sheet heights), and index.html asks for
    // viewport-fit=cover. Letting WebKit add its own insets on top of that
    // would double-pad every one of them.
    contentInset: "never",
    // The app is a tool, not a document; pinch-zooming the UI only ever
    // happens by accident in a work glove.
    zoomEnabled: false,
  },

  server: {
    iosScheme: "capacitor",
  },

  plugins: {
    SplashScreen: {
      // Auto-hide rather than a programmatic hide() call: that would mean
      // importing @capacitor/core into apps/web, and the web bundle is
      // deliberately free of Capacitor. The gate screen renders synchronously
      // on first paint, so there is nothing to wait for.
      launchAutoHide: true,
      launchShowDuration: 600,
      backgroundColor: "#ffffff",
    },
    Keyboard: {
      // "native" lets iOS resize the WebView itself, which keeps the bottom
      // nav and sticky footers where the CSS expects them.
      resize: KeyboardResize.Native,
    },
  },
};

export default config;
