# SMPL — native iOS shell

A [Capacitor](https://capacitorjs.com) wrapper that ships the existing `apps/web`
SPA as a real iOS app. There is no second UI codebase: the app **is** the mobile
web build, bundled into a native container.

## Why bundle the assets instead of loading the server

The obvious approach — a WebView pointed at `https://smpl-office.duckdns.org` —
was rejected on purpose.

Capacitor serves the bundled SPA from `capacitor://localhost`. A custom scheme
is a **secure context**, which is what makes `getUserMedia` available. The
Werkstatt barcode scanner is blocked in mobile Safari whenever the server is
reached over plain `http://` on the LAN — that is the `insecure_context` branch
in `CameraScannerSheet`. Inside the shell that branch is unreachable and the
camera works regardless of how the server is addressed.

The app shell also launches without waiting on the network.

The cost is that `/api/...` no longer resolves to the server — it resolves to the
app bundle, which has no API. `apps/web/src/native/` exists to fix exactly that,
and is inert in a browser.

## Prerequisites

- Xcode with an iOS simulator runtime
- CocoaPods (`brew install cocoapods`)
- Node 20+

> The iOS project is generated with `--packagemanager CocoaPods`. Capacitor 8
> defaults to Swift Package Manager, but that route pulls `Capacitor.xcframework`
> from a GitHub release, and SwiftPM's download path consults the macOS Keychain
> for credentials — a call that hangs indefinitely on a machine where the
> Keychain cannot prompt, with no output and no timeout. CocoaPods resolves every
> pod from local `node_modules` paths instead, so the build is offline and
> deterministic. If you ever regenerate `ios/`, keep the flag.

## Build and run

```bash
cd apps/mobile
npm install
npm run sync          # builds apps/web, then copies into ios/ and updates pods
npm run open          # opens the workspace in Xcode
```

`npm run sync` bakes in the default server address. Override it per build:

```bash
VITE_SMPL_SERVER_URL=https://smpl-office.duckdns.org npm run sync
```

To build and run headlessly against a simulator:

```bash
xcodebuild -workspace ios/App/App.xcworkspace -scheme App -configuration Debug -destination "platform=iOS Simulator,name=iPhone 17" CODE_SIGNING_ALLOWED=NO build
```

## Which server the app talks to

Resolution order, handled in `apps/web/src/native/shell.ts`:

1. An address the user saved on this device (`localStorage`, key `smpl.server_url`)
2. `VITE_SMPL_SERVER_URL`, baked in at build time
3. Otherwise the setup screen asks for one

On every launch the stored address is probed against `/api/healthz`. If it does
not answer, the setup screen reappears with the old value prefilled — which is
what makes a moved LAN IP self-healing rather than a support call. An address is
only saved after it has actually answered, so a typo cannot strand the app.

`https://smpl-office.duckdns.org` works both on the LAN and off-site and needs no
App Transport Security exception. A bare LAN IP (`http://192.168.1.127`) also
works: `Info.plist` carries `NSAllowsLocalNetworking`, which permits cleartext to
private address ranges only, without weakening TLS for anything on the internet.

## What the server must allow

The shell is a cross-origin client, so `apps/api` needs two things. Both are
already defaults in the repo — no per-deployment env change:

| Setting | Value | Why |
| --- | --- | --- |
| `cors_origins` | includes `capacitor://localhost` | Otherwise every request dies in preflight |
| `expose_headers` | `X-Access-Token`, `Content-Disposition` | Cross-origin JS can only read the seven CORS-safelisted response headers. Login reads its JWT out of `X-Access-Token`; without exposing it the client sees `null` and reports "No access token returned" on a request the server authenticated perfectly. |

Authentication itself is unaffected: the API accepts a Bearer token, and the CSRF
check applies only to cookie-authenticated requests. WebKit's third-party-cookie
blocking therefore costs the shell nothing.

## Privacy strings

`Info.plist` declares camera (barcode scanning, report photos), photo library
(report attachments), and local network (LAN server) usage. Strings are German,
matching the crew-facing UI.

## Known gaps

- **File downloads.** Report PDFs and XLSX exports open through blob URLs. In a
  plain `WKWebView` these need a `WKDownloadDelegate` to reach the Files app;
  untested here.
- **Push notifications.** The service worker is skipped in the shell (WebKit does
  not run service workers on custom schemes). Real APNs push would need
  `@capacitor/push-notifications` and a server-side change.
- **Signing.** The project builds unsigned for the simulator. Distribution to
  real devices needs a signing team in Xcode.
