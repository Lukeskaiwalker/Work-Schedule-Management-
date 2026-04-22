import { useCallback, useState } from "react";
import { useAppContext } from "../../context/AppContext";
import { useBarcodeScanner } from "../../hooks/useBarcodeScanner";
import { useIsMobileViewport } from "../../hooks/useIsMobileViewport";
import { MOCK_MOBILE_RECENT_SCANS } from "../../components/werkstatt/mockData";

/**
 * WerkstattMobileScanPage — mobile-only full-screen QR scanner surface,
 * ported from Paper artboard AIX-0 ("Werkstatt — Mobile: QR-Scanner").
 *
 * Self-gates on:
 *   - mainView === "werkstatt_scan"
 *   - viewport < 768px
 *
 * Scan input paths:
 *   - PRIMARY: external Bluetooth / USB HID scanner via useBarcodeScanner.
 *     The hook attaches a global keydown listener that detects high-speed
 *     character bursts terminated by Enter and fires onScan(code).
 *   - Manual fallback: an input field revealed by the "Manuell eingeben"
 *     CTA. When submitted we fire the same resolveScan pipeline.
 *   - Real camera QR decoding via @zxing/browser is DEFERRED per the
 *     Werkstatt contract's scope caps — the dark viewport is a static
 *     visual only.
 *
 * Scan resolution currently stubs the network call with a local
 * "resolving…" state. TODO(werkstatt): call
 * GET /api/werkstatt/scan/resolve?code=<raw> once Mobile BE lands.
 */
export function WerkstattMobileScanPage() {
  const { mainView, setMainView, language } = useAppContext();
  const { isMobile } = useIsMobileViewport();

  const [resolvingCode, setResolvingCode] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualValue, setManualValue] = useState("");

  const resolveScan = useCallback((code: string) => {
    // TODO(werkstatt): fetch `/api/werkstatt/scan/resolve?code=${code}` and
    // dispatch on ScanResolveResult.kind — werkstatt_article → open
    // ArtikelDetail; catalog_match → open picker; not_found → show toast.
    setLastError(null);
    setResolvingCode(code);
  }, []);

  // The HID scanner wedge detects high-speed keystroke bursts; enabled=true
  // attaches the global listener. It suppresses itself when focus is in an
  // input/textarea (see hook source) so the manual input below still works.
  const scannerActive =
    mainView === "werkstatt_scan" && isMobile && !manualOpen;

  useBarcodeScanner({
    enabled: scannerActive,
    onScan: resolveScan,
  });

  if (mainView !== "werkstatt_scan") return null;
  if (!isMobile) return null;

  const de = language === "de";

  const closeScanner = () => {
    setResolvingCode(null);
    setLastError(null);
    setMainView("werkstatt");
  };

  const submitManual = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = manualValue.trim();
    if (trimmed.length < 3) {
      setLastError(
        de ? "Mindestens 3 Zeichen" : "At least 3 characters",
      );
      return;
    }
    setManualOpen(false);
    setManualValue("");
    resolveScan(trimmed);
  };

  return (
    <section
      className="werkstatt-mobile werkstatt-mobile--scan"
      aria-label={de ? "QR-Code scannen" : "Scan QR code"}
    >
      <header className="werkstatt-mobile-scan-top">
        <button
          type="button"
          className="werkstatt-mobile-scan-topbtn"
          onClick={closeScanner}
          aria-label={de ? "Scanner schließen" : "Close scanner"}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 6 L18 18" />
            <path d="M18 6 L6 18" />
          </svg>
        </button>
        <div className="werkstatt-mobile-scan-topcenter">
          <span className="werkstatt-mobile-scan-eyebrow">
            {de ? "Werkstatt" : "Werkstatt"}
          </span>
          <span className="werkstatt-mobile-scan-title">
            {de ? "QR-Code scannen" : "Scan QR code"}
          </span>
        </div>
        <button
          type="button"
          className="werkstatt-mobile-scan-topbtn"
          aria-label={de ? "Blitz" : "Torch"}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 2 L4 14 h7 l-1 8 l9-12 h-7 z" />
          </svg>
        </button>
      </header>

      <div className="werkstatt-mobile-scan-viewport">
        <div className="werkstatt-mobile-scan-gradient" aria-hidden="true" />
        <div className="werkstatt-mobile-scan-reticle" aria-hidden="true">
          <span className="werkstatt-mobile-scan-corner werkstatt-mobile-scan-corner--tl" />
          <span className="werkstatt-mobile-scan-corner werkstatt-mobile-scan-corner--tr" />
          <span className="werkstatt-mobile-scan-corner werkstatt-mobile-scan-corner--bl" />
          <span className="werkstatt-mobile-scan-corner werkstatt-mobile-scan-corner--br" />
          <span className="werkstatt-mobile-scan-line" />
        </div>
        <p className="werkstatt-mobile-scan-helper">
          {resolvingCode
            ? de
              ? `Auflösen: ${resolvingCode}…`
              : `Resolving: ${resolvingCode}…`
            : de
              ? "Richte die Kamera auf den QR-Code am Artikel."
              : "Point the camera at the article's QR code."}
        </p>
        {lastError ? (
          <p className="werkstatt-mobile-scan-error">{lastError}</p>
        ) : null}
      </div>

      <div className="werkstatt-mobile-scan-history">
        <div className="werkstatt-mobile-scan-history-head">
          <span className="werkstatt-mobile-scan-history-eyebrow">
            {de ? "Zuletzt gescannt" : "Recently scanned"}
          </span>
          <span className="werkstatt-mobile-scan-history-link">
            {de ? "Verlauf" : "History"}
          </span>
        </div>
        <div className="werkstatt-mobile-scan-history-chips">
          {MOCK_MOBILE_RECENT_SCANS.map((code) => (
            <button
              key={code}
              type="button"
              className="werkstatt-mobile-scan-chip"
              onClick={() => resolveScan(code)}
            >
              <span
                className="werkstatt-mobile-scan-chip-icon"
                aria-hidden="true"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#8FCAFF" strokeWidth="2.4">
                  <rect x="3" y="3" width="7" height="7" rx="1.2" />
                  <rect x="14" y="3" width="7" height="7" rx="1.2" />
                  <rect x="3" y="14" width="7" height="7" rx="1.2" />
                </svg>
              </span>
              <span className="werkstatt-mobile-scan-chip-label">{code}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="werkstatt-mobile-scan-manual">
        {manualOpen ? (
          <form
            className="werkstatt-mobile-scan-manual-form"
            onSubmit={submitManual}
          >
            <input
              autoFocus
              type="text"
              className="werkstatt-mobile-scan-manual-input"
              placeholder={de ? "SP-Nummer oder EAN" : "SP number or EAN"}
              value={manualValue}
              onChange={(event) => setManualValue(event.target.value)}
            />
            <button
              type="submit"
              className="werkstatt-mobile-scan-manual-submit"
            >
              {de ? "Suchen" : "Find"}
            </button>
            <button
              type="button"
              className="werkstatt-mobile-scan-manual-cancel"
              onClick={() => {
                setManualOpen(false);
                setManualValue("");
                setLastError(null);
              }}
            >
              {de ? "Abbrechen" : "Cancel"}
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="werkstatt-mobile-scan-manual-btn"
            onClick={() => setManualOpen(true)}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <path d="M7 10h.01" />
              <path d="M11 10h.01" />
              <path d="M15 10h.01" />
              <path d="M7 14h10" />
            </svg>
            <span>{de ? "Manuell eingeben" : "Enter manually"}</span>
          </button>
        )}
      </div>
    </section>
  );
}
