/**
 * WerkstattMobileScanPage — the fullscreen scanner.
 *
 * Was a static mock: a dark rectangle with an animated line, and a
 * `resolveScan` that set a "resolving…" string and stopped. It now runs the
 * real decoder and the real cascade.
 *
 * Reuses the Baustellenkisten scanner's engine rather than a second
 * implementation — `useCameraScanner` already solves the parts that are easy to
 * get wrong (lazy-loading the ~90 kB decoder only when the camera is actually
 * opened, reporting an insecure context as its own error instead of an
 * unreadable TypeError, releasing the MediaStream under StrictMode's double
 * effect, and suppressing repeats on an EDGE rather than a timer). What is NOT
 * reused is `CameraScannerSheet`: that is a sheet designed to sit ON TOP of a
 * page, and this page IS the scanner — it already has its own Paper chrome.
 *
 * Three input paths, one pipeline:
 *   - the camera (primary, and new),
 *   - an external Bluetooth/USB HID scanner via useBarcodeScanner,
 *   - manual entry, for a label that is scratched off.
 */
import { useCallback, useRef, useState } from "react";

import { apiFetch } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import { useBarcodeScanner } from "../../hooks/useBarcodeScanner";
import { useCameraScanner } from "../../hooks/useCameraScanner";
import { useIsMobileViewport } from "../../hooks/useIsMobileViewport";
import {
  cameraErrorIsRetryable,
  cameraErrorText,
} from "../../components/werkstatt/cameraErrors";
import { MaschineBuchenModal } from "../../components/werkstatt/MaschineBuchenModal";
import { MaschineScanSheet } from "../../components/werkstatt/MaschineScanSheet";
import type { ScanResolveResult, WerkstattLocation } from "../../types/werkstatt";
import type { Machine, MachineBookPayload } from "../../types/werkstattMachines";
import { bookMachine, returnMachine } from "../../utils/werkstattMachinesApi";

export function WerkstattMobileScanPage() {
  const {
    mainView,
    setMainView,
    setWerkstattTab,
    setActiveWerkstattArticleId,
    setActiveWerkstattMachineId,
    language,
    token,
    user,
    assignableUsers,
    setError,
    setNotice,
  } = useAppContext();
  const { isMobile } = useIsMobileViewport();
  const de = language === "de";

  const [machine, setMachine] = useState<Machine | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualValue, setManualValue] = useState("");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [locations, setLocations] = useState<WerkstattLocation[]>([]);

  /**
   * One resolve at a time.
   *
   * The decoder re-fires as long as a label stays in frame, and a resolve is a
   * network round trip. Without this, walking past a rack of labelled machines
   * would queue a dozen overlapping lookups and the sheet would land on
   * whichever returned last rather than what the user pointed at.
   */
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());

  const resolveNow = useCallback(
    async (code: string) => {
      setMessage(null);
      try {
        const result = await apiFetch<ScanResolveResult>(
          `/werkstatt/scan/resolve?code=${encodeURIComponent(code)}`,
          token,
        );

        switch (result.kind) {
          case "machine":
            setMachine(result.machine);
            return;

          case "werkstatt_article":
            // Articles already have a home; hand off and leave the scanner.
            setActiveWerkstattArticleId(result.article.id);
            setWerkstattTab("artikel");
            setMainView("werkstatt");
            return;

          case "catalog_match":
            setMessage(
              de
                ? `Nur im Katalog gefunden (${result.catalog_items.length}) — noch kein Lagerartikel.`
                : `Only found in the catalogue (${result.catalog_items.length}) — not stocked yet.`,
            );
            return;

          default:
            setMessage(
              de ? `Nichts gefunden zu „${result.code}“` : `Nothing found for "${result.code}"`,
            );
        }
      } catch (err: unknown) {
        setMessage(err instanceof Error ? err.message : String(err));
      }
    },
    [token, de, setActiveWerkstattArticleId, setWerkstattTab, setMainView],
  );

  const resolveScan = useCallback(
    (code: string) => {
      // A sheet is open — the user is deciding, not scanning. Ignoring decodes
      // here is what stops a label still lying in frame from replacing the
      // machine they are about to book.
      if (machine || busy) return;
      const next = queueRef.current.then(() => resolveNow(code));
      queueRef.current = next.catch(() => undefined);
    },
    [machine, busy, resolveNow],
  );

  const scannerActive = mainView === "werkstatt_scan" && isMobile;
  const cameraActive = scannerActive && !manualOpen && !machine && !optionsOpen;

  const { status, error, sighted, videoRef, retry } = useCameraScanner({
    active: cameraActive,
    onScan: resolveScan,
  });

  // The HID wedge suppresses itself while an input is focused, so manual entry
  // still works; disabled while a sheet is up for the same reason as above.
  useBarcodeScanner({
    enabled: scannerActive && !manualOpen && !machine && !optionsOpen,
    onScan: resolveScan,
  });

  const loadLocations = useCallback(async () => {
    if (locations.length > 0) return;
    try {
      setLocations(await apiFetch<WerkstattLocation[]>("/werkstatt/locations", token));
    } catch {
      // Degrades the vehicle picker to "unchanged"; must not block booking.
      setLocations([]);
    }
  }, [locations.length, token]);

  /** Run a booking/return, then leave the scanner ready for the next tool. */
  const runAction = useCallback(
    async (action: () => Promise<string>) => {
      setBusy(true);
      try {
        setNotice(await action());
        setMachine(null);
        setOptionsOpen(false);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [setNotice, setError],
  );

  const book = useCallback(
    (payload: MachineBookPayload) => {
      if (!machine) return;
      void runAction(async () => {
        const changed = await bookMachine(token, machine.id, payload);
        return changed.length > 1
          ? de
            ? `${machine.unit_number} auf dich — inkl. ${changed.length - 1} Komponente(n)`
            : `${machine.unit_number} taken — including ${changed.length - 1} component(s)`
          : de
            ? `${machine.unit_number} auf dich gebucht`
            : `${machine.unit_number} booked to you`;
      });
    },
    [machine, token, runAction, de],
  );

  if (mainView !== "werkstatt_scan") return null;
  if (!isMobile) return null;

  const failure = error ? cameraErrorText(error, de) : null;
  const currentUserName = user?.full_name || user?.email || (de ? "dich" : "you");

  const closeScanner = () => {
    setMachine(null);
    setMessage(null);
    setOptionsOpen(false);
    setMainView("werkstatt");
  };

  const submitManual = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = manualValue.trim();
    if (trimmed.length < 2) {
      setMessage(de ? "Mindestens 2 Zeichen" : "At least 2 characters");
      return;
    }
    setManualOpen(false);
    setManualValue("");
    resolveScan(trimmed);
  };

  return (
    <section
      className="werkstatt-mobile werkstatt-mobile--scan"
      aria-label={de ? "Code scannen" : "Scan code"}
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
          <span className="werkstatt-mobile-scan-eyebrow">Werkstatt</span>
          <span className="werkstatt-mobile-scan-title">
            {de ? "Maschine oder Artikel scannen" : "Scan a machine or item"}
          </span>
        </div>
        <span className="werkstatt-mobile-scan-topbtn werkstatt-mobile-scan-topbtn--ghost" aria-hidden="true" />
      </header>

      <div className="werkstatt-mobile-scan-viewport">
        {/* playsInline + muted are REQUIRED on iOS: without them Safari either
            refuses to autoplay or takes the video fullscreen on its own. */}
        <video
          ref={videoRef}
          className="werkstatt-mobile-scan-video"
          playsInline
          muted
          autoPlay
        />
        <div className="werkstatt-mobile-scan-gradient" aria-hidden="true" />

        {!failure && (
          <div
            className={`werkstatt-mobile-scan-reticle${
              sighted ? " werkstatt-mobile-scan-reticle--sighted" : ""
            }`}
            aria-hidden="true"
          >
            <span className="werkstatt-mobile-scan-corner werkstatt-mobile-scan-corner--tl" />
            <span className="werkstatt-mobile-scan-corner werkstatt-mobile-scan-corner--tr" />
            <span className="werkstatt-mobile-scan-corner werkstatt-mobile-scan-corner--bl" />
            <span className="werkstatt-mobile-scan-corner werkstatt-mobile-scan-corner--br" />
            <span className="werkstatt-mobile-scan-line" />
          </div>
        )}

        {failure ? (
          <div className="werkstatt-mobile-scan-failure">
            <strong>{failure.title}</strong>
            <p>{failure.body}</p>
            {error && cameraErrorIsRetryable(error) && (
              <button type="button" className="werkstatt-mobile-scan-retry" onClick={retry}>
                {de ? "Erneut versuchen" : "Try again"}
              </button>
            )}
            <p className="werkstatt-mobile-scan-fallback">
              {de
                ? "Bluetooth-Scanner und manuelle Eingabe funktionieren weiterhin."
                : "The Bluetooth scanner and manual entry still work."}
            </p>
          </div>
        ) : (
          <p className="werkstatt-mobile-scan-helper">
            {status === "starting"
              ? de
                ? "Kamera wird gestartet…"
                : "Starting camera…"
              : sighted
                ? de
                  ? "Code erkannt…"
                  : "Code detected…"
                : de
                  ? "Richte die Kamera auf das Maschinen-Etikett (M-0001) oder den Barcode."
                  : "Point the camera at the machine label (M-0001) or the barcode."}
          </p>
        )}

        {message ? <p className="werkstatt-mobile-scan-error">{message}</p> : null}
      </div>

      <div className="werkstatt-mobile-scan-manual">
        {manualOpen ? (
          <form className="werkstatt-mobile-scan-manual-form" onSubmit={submitManual}>
            <input
              autoFocus
              type="text"
              className="werkstatt-mobile-scan-manual-input"
              placeholder={de ? "M-0001, SP-Nummer oder EAN" : "M-0001, SP number or EAN"}
              value={manualValue}
              onChange={(event) => setManualValue(event.target.value)}
            />
            <button type="submit" className="werkstatt-mobile-scan-manual-submit">
              {de ? "Suchen" : "Find"}
            </button>
            <button
              type="button"
              className="werkstatt-mobile-scan-manual-cancel"
              onClick={() => {
                setManualOpen(false);
                setManualValue("");
                setMessage(null);
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

      {machine && !optionsOpen && (
        <MaschineScanSheet
          machine={machine}
          language={language}
          currentUserId={user?.id ?? null}
          currentUserName={currentUserName}
          busy={busy}
          onBookToday={() =>
            book({ holder_user_id: user?.id ?? null, for_today: true })
          }
          onOpenOptions={() => {
            void loadLocations();
            setOptionsOpen(true);
          }}
          onReturn={() =>
            void runAction(async () => {
              const changed = await returnMachine(token, machine.id, {});
              return changed.length > 1
                ? de
                  ? `${machine.unit_number} zurück — inkl. ${changed.length - 1} Komponente(n)`
                  : `${machine.unit_number} returned — including ${changed.length - 1} component(s)`
                : de
                  ? `${machine.unit_number} zurückgebucht`
                  : `${machine.unit_number} returned`;
            })
          }
          onOpenDetail={() => {
            setActiveWerkstattMachineId(machine.id);
            setWerkstattTab("maschinen");
            setMainView("werkstatt");
          }}
          onDismiss={() => setMachine(null)}
        />
      )}

      {machine && optionsOpen && (
        <MaschineBuchenModal
          open
          language={language}
          machine={machine}
          users={assignableUsers}
          locations={locations}
          currentUserId={user?.id ?? null}
          busy={busy}
          onClose={() => setOptionsOpen(false)}
          onConfirm={book}
        />
      )}
    </section>
  );
}
