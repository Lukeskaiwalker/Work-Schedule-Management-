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
import { BestandAnpassenModal } from "../../components/werkstatt/BestandAnpassenModal";
import { MaschineBuchenModal } from "../../components/werkstatt/MaschineBuchenModal";
import { MaschineScanSheet } from "../../components/werkstatt/MaschineScanSheet";
import { NeuerArtikelModal } from "../../components/werkstatt/NeuerArtikelModal";
import { stockAdjustmentNotice } from "../../components/werkstatt/stockNotices";
import type {
  ScanResolveResult,
  WerkstattArticle,
  WerkstattLocation,
} from "../../types/werkstatt";
import type { Machine, MachineBookPayload } from "../../types/werkstattMachines";
import { bookMachine, returnMachine } from "../../utils/werkstattMachinesApi";
import { adjustArticleStock, getArticle } from "../../utils/werkstattArticlesApi";

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
  /* A scanned code that resolved to nothing stockable. Held so the "anlegen"
   * button can hand it straight to the create dialog: the person is standing
   * in front of the item with the barcode already read, and making them type
   * it again on a phone is how stock stops being entered at all. */
  const [offerCreate, setOfferCreate] = useState<string | null>(null);
  const [createCode, setCreateCode] = useState<string | null>(null);
  /* The create dialog can discover that the code IS stocked — under another
   * spelling of the barcode — and hand off. The hand-off used to set
   * `activeWerkstattArticleId` and switch to the "artikel" tab, which was then
   * a fixture printing LAGER 0 / UNTERWEGS 0 / BESTAND 0 for a real article
   * with fourteen on the shelf. That page is wired now and adjusts, checks out
   * and returns for real — but the dialog still opens HERE, because the reason
   * has outlived the fixture: the person is standing in front of the item with
   * the barcode already read, and what they came to do is put it into stock.
   * Sending them to another screen to find the same dialog in a menu is how a
   * delivery stops being booked at all. The scan cascade's own
   * `werkstatt_article` branch below still hands off, and now lands on real
   * numbers. */
  const [stockArticle, setStockArticle] = useState<WerkstattArticle | null>(null);
  const [stockSaving, setStockSaving] = useState(false);
  const [stockError, setStockError] = useState<string | null>(null);

  /* POST /werkstatt/articles needs `werkstatt:manage`; the lookup behind the
   * dialog's first step deliberately does not. Offering "anlegen" without the
   * permission costs a filled-in dialog to find out — the same rule the
   * Bestand page's row menu follows. */
  const canManageStock = (user?.effective_permissions ?? []).includes("werkstatt:manage");

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
      setOfferCreate(null);
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
            setOfferCreate(code);
            return;

          default:
            setMessage(
              de ? `Nichts gefunden zu „${result.code}“` : `Nothing found for "${result.code}"`,
            );
            setOfferCreate(code);
        }
      } catch (err: unknown) {
        setMessage(err instanceof Error ? err.message : String(err));
      }
    },
    [token, de, setActiveWerkstattArticleId, setWerkstattTab, setMainView],
  );

  /** Load the article the create dialog handed back, then open the dialog. */
  const openStockDialog = useCallback(
    async (articleId: number) => {
      try {
        setStockArticle(await getArticle(token, articleId));
      } catch (err: unknown) {
        // No silent dead end: the button said a dialog would open.
        setMessage(err instanceof Error ? err.message : String(err));
      }
    },
    [token],
  );

  /**
   * Book the adjustment. Closes the dialog only on success.
   *
   * A stock-take sends the TARGET total with the figure it was shown as an
   * optimistic lock — a count is a statement about one observed total and has
   * to be refused if the shelf moved underneath it. A delivery is not: three
   * boxes arrived whatever else happened.
   */
  const confirmStock = useCallback(
    async (payload: {
      kind: "intake" | "defect" | "inventory";
      amount: number;
      new_total: number;
      reason: string;
    }) => {
      if (!stockArticle || stockSaving) return;
      setStockSaving(true);
      setStockError(null);
      try {
        const snapshot = await adjustArticleStock(
          token,
          stockArticle.id,
          payload.kind === "inventory"
            ? {
                kind: "inventory",
                targetTotal: payload.new_total,
                reason: payload.reason,
                expectedTotal: stockArticle.stock_total,
              }
            : { kind: payload.kind, quantity: payload.amount, reason: payload.reason },
        );
        setStockArticle(null);
        setOfferCreate(null);
        setNotice(
          stockAdjustmentNotice(
            {
              kind: payload.kind,
              itemName: stockArticle.item_name,
              amount: payload.amount,
              confirmedTotalBefore:
                payload.kind === "inventory" ? stockArticle.stock_total : null,
              totalAfter: snapshot.stock_total,
              availableAfter: snapshot.stock_available,
            },
            de,
          ),
        );
      } catch (err: unknown) {
        setStockError(err instanceof Error ? err.message : String(err));
      } finally {
        setStockSaving(false);
      }
    },
    [stockArticle, stockSaving, token, de, setNotice],
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
  const cameraActive =
    scannerActive && !manualOpen && !machine && !optionsOpen && createCode === null;

  const { status, error, sighted, videoRef, retry } = useCameraScanner({
    active: cameraActive,
    onScan: resolveScan,
  });

  // The HID wedge suppresses itself while an input is focused, so manual entry
  // still works; disabled while a sheet is up for the same reason as above.
  useBarcodeScanner({
    enabled: scannerActive && !manualOpen && !machine && !optionsOpen && createCode === null,
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
        {offerCreate &&
          (canManageStock ? (
            /* The dead end this removes: the phone recognised a code, said so,
               and left the person with nothing to press. */
            <button
              type="button"
              className="werkstatt-mobile-scan-create"
              onClick={() => setCreateCode(offerCreate)}
            >
              {de ? "Als Lagerartikel anlegen" : "Add as a stock item"}
            </button>
          ) : (
            <p className="werkstatt-mobile-scan-helper">
              {de
                ? "Anlegen darf nur das Büro (Berechtigung „Werkstatt verwalten“) — Code durchgeben genügt."
                : "Only the office can add items (permission “manage workshop”) — passing on the code is enough."}
            </p>
          ))}
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

      <NeuerArtikelModal
        open={createCode !== null}
        onClose={() => setCreateCode(null)}
        language={language}
        token={token}
        seedCode={createCode}
        onCreated={(article) => {
          setCreateCode(null);
          setOfferCreate(null);
          setMessage(null);
          setNotice(
            de
              ? `${article.article_number} „${article.item_name}“ angelegt`
              : `${article.article_number} “${article.item_name}” created`,
          );
        }}
        onAdjustStock={(articleId) => {
          // The article turned out to exist after all. Booked here, on the
          // screen the person is already looking at, from the row the server
          // just returned — see the note on `stockArticle` for why this stays
          // in place now that the article screen is no longer a fixture.
          setCreateCode(null);
          setStockError(null);
          void openStockDialog(articleId);
        }}
      />

      {stockArticle && (
        <BestandAnpassenModal
          open
          language={language}
          article={{
            item_name: stockArticle.item_name,
            article_number: stockArticle.article_number,
            category_name: stockArticle.category_name,
            stock_total: stockArticle.stock_total,
            stock_available: stockArticle.stock_available,
            unit: stockArticle.unit,
          }}
          submitting={stockSaving}
          error={stockError}
          onClose={() => {
            setStockArticle(null);
            setStockError(null);
          }}
          onConfirm={(payload) => void confirmStock(payload)}
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
