/**
 * CameraScannerSheet — fullscreen camera barcode scanner.
 *
 * The component stays mounted and renders null when closed; the camera is
 * released by the hook's effect cleanup, which runs when `active` flips to
 * false. The sheet reports every decode and lets the caller decide what to add,
 * so a packer can scan a whole crate without closing it between items.
 *
 * The scanned-count line is the only feedback the packer gets while the sheet
 * covers the contents list, so it is deliberately large.
 */
import { useEffect, useState } from "react";

import { useCameraScanner, type CameraScannerError } from "../../hooks/useCameraScanner";

/**
 * What the caller made of a decoded code. The sheet is the packer's ONLY
 * feedback channel while it covers the page — the app-level error banner is
 * behind it — so a failed add has to be reported here, and must never be
 * counted as a scan.
 */
export type ScanOutcome = { ok: boolean; label: string };

type Props = {
  open: boolean;
  language: string;
  onClose: () => void;
  onScan: (code: string) => Promise<ScanOutcome>;
};

function errorText(error: CameraScannerError, de: boolean): { title: string; body: string } {
  switch (error) {
    case "insecure_context":
      return {
        title: de ? "Kamera nur über HTTPS" : "Camera needs HTTPS",
        body: de
          ? "Browser erlauben die Kamera nur über eine sichere Verbindung. Über http:// im lokalen Netz bleibt sie gesperrt — Bluetooth-Scanner und Suche funktionieren weiterhin."
          : "Browsers only allow the camera over a secure connection. Reached over plain http:// on the LAN it stays blocked — the Bluetooth scanner and search still work.",
      };
    case "unsupported":
      return {
        title: de ? "Kamera nicht verfügbar" : "Camera unavailable",
        body: de
          ? "Dieser Browser unterstützt keinen Kamerazugriff."
          : "This browser does not support camera access.",
      };
    case "permission_denied":
      return {
        title: de ? "Kamerazugriff abgelehnt" : "Camera access denied",
        body: de
          ? "Erlaube den Kamerazugriff in den Browser-Einstellungen und versuche es erneut."
          : "Allow camera access in your browser settings, then try again.",
      };
    case "no_camera":
      return {
        title: de ? "Keine Kamera gefunden" : "No camera found",
        body: de
          ? "Es wurde keine nutzbare Kamera gefunden oder sie wird von einer anderen App belegt."
          : "No usable camera was found, or another app is holding it.",
      };
    case "load_failed":
      return {
        title: de ? "Scanner nicht geladen" : "Scanner failed to load",
        body: de
          ? "Der Scanner konnte nicht geladen werden. Prüfe die Verbindung und versuche es erneut."
          : "The scanner could not be downloaded. Check the connection and try again.",
      };
    default:
      return {
        title: de ? "Kamera konnte nicht starten" : "Camera could not start",
        body: de ? "Bitte erneut versuchen." : "Please try again.",
      };
  }
}

export function CameraScannerSheet({ open, language, onClose, onScan }: Props) {
  const de = language === "de";
  const [scanCount, setScanCount] = useState(0);
  const [outcome, setOutcome] = useState<ScanOutcome | null>(null);
  const [busy, setBusy] = useState(false);

  // The component is never unmounted, so both have to be reset per session —
  // otherwise reopening shows the previous run's total and last result.
  useEffect(() => {
    if (open) {
      setScanCount(0);
      setOutcome(null);
      setBusy(false);
    }
  }, [open]);

  const { status, error, sighted, videoRef, retry } = useCameraScanner({
    active: open,
    onScan: (code) => {
      // Count only what actually landed in the crate. Incrementing on decode
      // would report a success for an item the server rejected.
      setBusy(true);
      void onScan(code)
        .then((result) => {
          setOutcome(result);
          if (result.ok) setScanCount((value) => value + 1);
        })
        .finally(() => setBusy(false));
    },
  });

  if (!open) return null;

  const failure = error ? errorText(error, de) : null;

  return (
    <div className="camera-scanner" role="dialog" aria-modal="true">
      <div className="camera-scanner-head">
        <span className="camera-scanner-title">
          {de ? "Kamera-Scan" : "Camera scan"}
        </span>
        <button type="button" className="camera-scanner-close" onClick={onClose}>
          {de ? "Fertig" : "Done"}
        </button>
      </div>

      <div className="camera-scanner-stage">
        {/* playsInline + muted are REQUIRED on iOS: without them Safari either
            refuses to autoplay or takes the video fullscreen on its own. */}
        <video
          ref={videoRef}
          className="camera-scanner-video"
          playsInline
          muted
          autoPlay
        />
        {!failure && (
          <div
            className={`camera-scanner-reticle${sighted ? " camera-scanner-reticle--sighted" : ""}`}
            aria-hidden="true"
          />
        )}

        {status === "starting" && !failure && (
          <p className="camera-scanner-status">
            {de ? "Kamera wird gestartet…" : "Starting camera…"}
          </p>
        )}

        {failure && (
          <div className="camera-scanner-error">
            <strong>{failure.title}</strong>
            <p>{failure.body}</p>
            {error !== "insecure_context" && error !== "unsupported" && (
              <button type="button" className="camera-scanner-retry" onClick={retry}>
                {de ? "Erneut versuchen" : "Try again"}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="camera-scanner-foot">
        {status === "scanning" && (
          <>
            {/* Live state, so the packer can tell "the camera cannot read
                this" from "it read it and is working on it". Without this the
                only signal was an item eventually appearing. */}
            <p
              className={`camera-scanner-live${
                busy
                  ? " camera-scanner-live--busy"
                  : sighted
                    ? " camera-scanner-live--sighted"
                    : ""
              }`}
            >
              <span className="camera-scanner-dot" aria-hidden="true" />
              {busy
                ? de
                  ? "Artikel wird gesucht…"
                  : "Looking up item…"
                : sighted
                  ? de
                    ? "Barcode erkannt"
                    : "Barcode detected"
                  : de
                    ? "Suche Barcode…"
                    : "Searching for a barcode…"}
            </p>
            <p className="camera-scanner-hint">
              {de
                ? "Für ein weiteres Stück kurz wegschwenken und erneut scannen."
                : "For another unit, pan away briefly and scan again."}
            </p>
          </>
        )}
        {(scanCount > 0 || outcome) && (
          <p
            className={`camera-scanner-count${
              outcome && !outcome.ok ? " camera-scanner-count--failed" : ""
            }`}
          >
            {scanCount}{" "}
            {de
              ? scanCount === 1
                ? "Artikel"
                : "Artikel"
              : scanCount === 1
                ? "item"
                : "items"}
            {outcome ? ` · ${outcome.label}` : ""}
          </p>
        )}
      </div>
    </div>
  );
}
