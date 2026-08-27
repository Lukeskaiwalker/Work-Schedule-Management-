/**
 * Checks the two capability probes that decide how a PDF is shown in the
 * in-app file viewer. Run with bare node, no dependencies:
 *
 *     npm run check --prefix apps/web
 *
 * These are pure functions with no DOM, but getting either wrong is invisible
 * until someone opens a document on the wrong phone — which is how the iOS
 * "only the first page" report reached us. The functions are lifted out of the
 * source at run time rather than copied, so this file cannot drift from what
 * actually ships; if a probe is renamed, this fails loudly instead of quietly
 * testing nothing.
 */
import { readFileSync } from "node:fs";

const src = readFileSync(
  new URL("../src/components/shared/NativeFileViewer.tsx", import.meta.url), "utf8");

function lift(name) {
  const m = new RegExp(`function ${name}\\([^)]*\\)[^{]*\\{[\\s\\S]*?\\n\\}`).exec(src);
  if (!m) throw new Error(`could not lift ${name}`);
  // Strip TS annotations so plain node can evaluate the function.
  return m[0]
    .replace(/: string \| null/g, "")
    .replace(/: (boolean|string|number)\b/g, "")
    .replace(/ as [A-Za-z<>{}?: ]+/g, "");
}

const ios = eval(`(${lift("pdfFrameShowsFirstPageOnly")})`);
const pagesBaseFor = eval(`(${lift("pagesBaseFor")})`);

let fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  got=${got} want=${want}`}`);
};

const UA = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  ipadOld: "Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1",
  ipadDesktop: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
};
// node >=21 defines a real `navigator` with only a getter.
const as = (ua, touch) =>
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: ua, maxTouchPoints: touch },
    configurable: true,
  });

console.log("pdfFrameShowsFirstPageOnly — must be true only where a framed PDF stops at page 1:");
as(UA.iphone, 5);      check("iPhone Safari", ios(), true);
as(UA.ipadOld, 5);     check("iPad (iOS 12 UA)", ios(), true);
as(UA.ipadDesktop, 5); check("iPadOS desktop-mode UA", ios(), true);
as(UA.mac, 0);         check("macOS Safari (not an iPad)", ios(), false);
as(UA.android, 5);     check("Android Chrome", ios(), false);
as(UA.windows, 0);     check("Windows Chrome", ios(), false);
as(UA.mac, undefined); check("macOS, maxTouchPoints undefined", ios(), false);

console.log("\npagesBaseFor — the pager only exists for file attachments:");
check("absolute /preview", pagesBaseFor("https://s.de/api/files/12/preview"), "https://s.de/api/files/12/preview-pages");
check("absolute /download", pagesBaseFor("https://s.de/api/files/12/download"), "https://s.de/api/files/12/preview-pages");
check("relative + query", pagesBaseFor("/api/files/7/preview?v=2"), "/api/files/7/preview-pages");
check("training report (no pager)", pagesBaseFor("https://s.de/api/training-reports/5/pdf"), null);
check("not a file route", pagesBaseFor("https://s.de/api/projects/3/export"), null);

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
