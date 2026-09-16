import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppContext } from "../../context/AppContext";
import { ApiError } from "../../api/client";
import { useBarcodeScanner } from "../../hooks/useBarcodeScanner";
import { useKeptRow } from "../../hooks/useKeptRow";
import { unitLabel } from "../../components/werkstatt/unitLabel";
import { NeuerArtikelModal } from "../../components/werkstatt/NeuerArtikelModal";
import { EntnehmenModal } from "../../components/werkstatt/EntnehmenModal";
import { BestandAnpassenModal } from "../../components/werkstatt/BestandAnpassenModal";
import { type MockInventoryRow, type MockStockTone } from "../../components/werkstatt/mockData";
import {
  adjustArticleStock,
  checkoutArticle,
  listArticles,
  printArticleLabel,
  type StockAdjustmentInput,
  type WerkstattArticleLite,
  type WerkstattArticleStockSnapshot,
} from "../../utils/werkstattArticlesApi";
import {
  staleStockMessage,
  stockAdjustmentNotice,
} from "../../components/werkstatt/stockNotices";
import { expectedReturnIso } from "../../utils/werkstattReturnDates";

/**
 * WerkstattInventarPage — full inventory list. Ported from Paper 7RO-0
 * "Alle Artikel". Self-gates on mainView+werkstattTab.
 *
 * Reads /api/werkstatt/articles. It previously rendered MOCK_INVENTORY_ROWS —
 * an EMPTY array — beside hard-coded filter counts (412/368/14/3/27), so the
 * page confidently reported four hundred articles over an empty table while
 * production held two hundred and forty-nine real ones. Counts are now derived
 * from the rows actually fetched, which is the only way the two can never
 * disagree again.
 *
 * External HID barcode scans are routed through useBarcodeScanner — a scan
 * outside any input jumps to the matching SP-/EAN-lookup. Until the BE
 * scan-resolve endpoint exists, the callback is a stub (see TODO below).
 */
type FilterKey = "all" | "available" | "low" | "empty" | "out";

type FilterDef = {
  key: FilterKey;
  label_de: string;
  label_en: string;
  count: number;
};

export function WerkstattInventarPage() {
  const { mainView, language, werkstattTab, projects, setNotice, setError, token, user } =
    useAppContext();

  /* The movements endpoint is gated on `werkstatt:manage`. Offering the
   * dialog to everyone meant an apprentice could pick a kind, type a count and
   * write a Beleg number, and learn only from a 403 that none of it was ever
   * going to be booked. Mirrors the server's gate exactly, `?? []` so an
   * unloaded user is treated as holding nothing rather than everything. */
  const canManageStock = (user?.effective_permissions ?? []).includes("werkstatt:manage");

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [location, setLocation] = useState<string>("all");
  const [activeFilter, setActiveFilter] = useState<FilterKey>("all");
  const [articles, setArticles] = useState<WerkstattArticleLite[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  /* Modal state — each modal gets its own slot; Entnehmen + BestandAnpassen
   * hold the row the user is acting on (null when closed). */
  const [neuerArtikelOpen, setNeuerArtikelOpen] = useState(false);
  const [printingId, setPrintingId] = useState<number | null>(null);
  const [labelNotice, setLabelNotice] = useState<string>("");
  /* The dialogs remember an ARTICLE ID, not a captured row. The row itself is
   * looked up from the current list on every render, so a refresh — after a
   * booking, or after a 409 saying the stock moved while the dialog was open —
   * flows straight into the open dialog. A captured row would keep showing the
   * figure the server has just told us is wrong. */
  const [entnehmenId, setEntnehmenId] = useState<number | null>(null);
  const [bestandId, setBestandId] = useState<number | null>(null);
  /* Both dialogs book real stock, so both need the in-flight/failed pair:
   * `saving` disables the confirm button (a double-tap would book twice), and
   * the error keeps the dialog open with the user's input intact. */
  const [saving, setSaving] = useState(false);
  const [entnehmenError, setEntnehmenError] = useState<string | null>(null);
  const [bestandError, setBestandError] = useState<string | null>(null);

  // TODO(werkstatt): replace stub with real /api/werkstatt/scan/resolve call.
  useBarcodeScanner({
    /* Disarmed while a dialog is open. The scanner is armed for the whole tab
     * and a stray scan lands in the search box, which refetches the list — so
     * a scanner nudged on the bench could rewrite the list under a dialog
     * somebody was mid-way through filling in. Nothing on either dialog reads
     * a scan anyway, so listening for one there buys nothing. */
    enabled:
      mainView === "werkstatt" &&
      werkstattTab === "inventar" &&
      entnehmenId === null &&
      bestandId === null,
    onScan: (code) => {
      // Placeholder: route the scan to the search box so users see a signal.
      setSearch(code);
    },
  });

  const active = mainView === "werkstatt" && werkstattTab === "inventar";

  const reload = useCallback(async () => {
    if (!active) return;
    setLoading(true);
    try {
      // Server-side search: the article table grows with every stock-take, so
      // fetching everything and filtering here would fail quietly as it grows.
      const rows = await listArticles(token, { q: search.trim() || undefined, limit: 500 });
      setArticles(rows);
      setLoadError(null);
    } catch (err) {
      // An empty table must never be mistaken for "no stock" — that is exactly
      // the failure this page shipped with.
      setArticles([]);
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [active, token, search]);

  useEffect(() => {
    const timer = window.setTimeout(() => void reload(), search ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [reload, search]);

  /** API row → the presentational shape this page already renders.
   *
   * MockInventoryRow is label-shaped, not number-shaped: it wants the strings
   * the table prints. Formatting here keeps the table dumb and means German
   * wording lives in one place instead of being rebuilt per cell.
   */
  const allRows = useMemo<MockInventoryRow[]>(
    () =>
      articles.map((a) => {
        const out = Math.max(0, a.stock_total - a.stock_available);
        // One abbreviation for this article, used by the row and by every
        // dialog the row opens. The row used to print a hard-coded "Stk" while
        // the dialog printed "St." — same article, two units, two numbers.
        const unit = unitLabel(a.unit, language === "de");
        const tone: MockStockTone =
          a.stock_status === "unavailable" ? "empty" : (a.stock_status as MockStockTone);
        return {
          id: String(a.id),
          article_no: a.article_number,
          item_name: a.item_name,
          sub_meta: [a.manufacturer, a.ean].filter(Boolean).join(" · "),
          category: a.category_name ?? "—",
          location: a.location_name ?? "—",
          stock_label: `${a.stock_available} ${unit}`,
          stock_available: a.stock_available,
          stock_total: a.stock_total,
          unit: a.unit ?? null,
          stock_tone: tone,
          out_initials: null,
          out_label:
            out > 0
              ? language === "de"
                ? `${out} unterwegs`
                : `${out} out`
              : null,
          in_transit_label: a.next_expected_delivery_at
            ? new Date(a.next_expected_delivery_at).toLocaleDateString(
                language === "de" ? "de-DE" : "en-US",
              )
            : null,
          article_id: a.id,
          // Either identifier makes the article findable with a scanner; with
          // neither, it can only be found by typing its name.
          scannable: Boolean(a.ean || a.internal_code),
        };
      }),
    [articles, language],
  );

  const counts = useMemo(() => {
    const by: Record<MockStockTone, number> = { available: 0, low: 0, empty: 0, out: 0 };
    for (const row of allRows) by[row.stock_tone] += 1;
    return by;
  }, [allRows]);

  const filters: ReadonlyArray<FilterDef> = useMemo(
    () => [
      { key: "all", label_de: "Alle", label_en: "All", count: allRows.length },
      { key: "available", label_de: "Verfügbar", label_en: "Available", count: counts.available },
      { key: "low", label_de: "Niedrig", label_en: "Low", count: counts.low },
      { key: "empty", label_de: "Leer", label_en: "Empty", count: counts.empty },
      { key: "out", label_de: "Unterwegs", label_en: "Out", count: counts.out },
    ],
    [allRows.length, counts],
  );

  const rows = useMemo<ReadonlyArray<MockInventoryRow>>(() => {
    const needle = search.trim().toLowerCase();
    return allRows.filter((row) => {
      if (activeFilter !== "all" && row.stock_tone !== activeFilter) return false;
      if (category !== "all" && row.category !== category) return false;
      if (location !== "all" && row.location !== location) return false;
      if (!needle) return true;
      return (
        row.item_name.toLowerCase().includes(needle) ||
        row.article_no.toLowerCase().includes(needle) ||
        row.category.toLowerCase().includes(needle) ||
        row.location.toLowerCase().includes(needle)
      );
    });
  }, [allRows, search, category, location, activeFilter]);

  /* Looked up by id on every render so a booking's new counters flow straight
   * into the open dialog — and kept alive across a refetch that no longer
   * contains the article (a search narrowed by a stray scan, a colleague
   * archiving the row), because unmounting a dialog mid-edit throws away the
   * typed amount, the reason and the error message explaining why it failed.
   * Live numbers when there are any, the last ones seen otherwise. */
  const entnehmenRow = useKeptRow(
    useMemo(
      () => allRows.find((row) => row.article_id === entnehmenId) ?? null,
      [allRows, entnehmenId],
    ),
    entnehmenId,
  );
  const bestandRow = useKeptRow(
    useMemo(
      () => allRows.find((row) => row.article_id === bestandId) ?? null,
      [allRows, bestandId],
    ),
    bestandId,
  );

  // Everything below is a hook, so it must sit ABOVE the early return.
  // React counts hooks per render: one extra on the renders where this
  // tab is active crashes the page the moment you navigate to it.
  const de = language === "de";

  /**
   * Print a shelf label for one article.
   *
   * Reloads afterwards because the first print mints the article's code, which
   * flips it from unscannable to scannable — the button's own appearance is
   * derived from that, so not reloading would leave it inviting a second print.
   */
  const handlePrintLabel = useCallback(
    async (row: MockInventoryRow) => {
      if (!token || printingId !== null) return;
      setPrintingId(row.article_id);
      setLabelNotice("");
      try {
        const result = await printArticleLabel(token, row.article_id);
        setLabelNotice(
          de
            ? `${result.internal_code} gedruckt – ${row.item_name}`
            : `Printed ${result.internal_code} – ${row.item_name}`,
        );
        if (result.minted) await reload();
      } catch (err) {
        // The server distinguishes "no printer configured" (503) from
        // "printer unreachable" (502); both arrive here as a message worth
        // showing verbatim, because the fix differs.
        setLabelNotice(err instanceof Error ? err.message : String(err));
      } finally {
        setPrintingId(null);
      }
    },
    [token, printingId, de, reload],
  );

  /**
   * Fold a write's response back into the list.
   *
   * Both endpoints answer with the article as it now stands, recomputed from
   * the movement ledger. Patching from that — rather than adding the delta the
   * browser previewed — means the number the user sees after booking is the
   * number the server holds, even if a colleague booked against the same
   * article a second earlier. Immutable: a new array of new rows.
   */
  const applyStockSnapshot = useCallback((snapshot: WerkstattArticleStockSnapshot) => {
    setArticles((prev) =>
      prev.map((a) =>
        a.id === snapshot.id
          ? {
              ...a,
              stock_total: snapshot.stock_total,
              stock_available: snapshot.stock_available,
              stock_status: snapshot.stock_status,
            }
          : a,
      ),
    );
  }, []);

  /** Check stock out of the workshop. Closes the dialog only on success. */
  const handleCheckout = useCallback(
    async (
      row: MockInventoryRow,
      payload: {
        quantity: number;
        project_id: string | null;
        expected_return: Parameters<typeof expectedReturnIso>[0];
        notes: string;
      },
    ) => {
      if (saving) return;
      setSaving(true);
      setEntnehmenError(null);
      try {
        const projectId = payload.project_id ? Number(payload.project_id) : null;
        const snapshot = await checkoutArticle(token, {
          articleId: row.article_id,
          quantity: payload.quantity,
          projectId: projectId !== null && Number.isFinite(projectId) ? projectId : null,
          expectedReturnAt: expectedReturnIso(payload.expected_return, new Date()),
          notes: payload.notes.trim() || null,
        });
        applyStockSnapshot(snapshot);
        setEntnehmenId(null);
        setNotice(
          de
            ? `${payload.quantity}× ${row.item_name} entnommen — ${snapshot.stock_available} von ${snapshot.stock_total} noch verfügbar`
            : `Checked out ${payload.quantity}× ${row.item_name} — ${snapshot.stock_available} of ${snapshot.stock_total} still available`,
        );
      } catch (err) {
        // Stays in the dialog: "more than available" and "article archived"
        // are both 400s the user can act on, and re-entering the form to read
        // the reason would lose what they picked.
        setEntnehmenError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [saving, token, applyStockSnapshot, setNotice, de],
  );

  /** Book a manual stock adjustment. Closes the dialog only on success. */
  const handleAdjustStock = useCallback(
    async (
      row: MockInventoryRow,
      payload: {
        kind: "intake" | "defect" | "inventory";
        amount: number;
        /** The total the entry implies. For a stock-take that is the counted
         *  shelf figure plus everything out or in repair — the dialog collects
         *  the shelf, the endpoint wants the total. */
        new_total: number;
        reason: string;
      },
    ) => {
      if (saving) return;
      setSaving(true);
      setBestandError(null);
      try {
        // Relative kinds send a positive quantity; a stock-take sends the
        // TARGET total its count implies and lets the server derive the delta,
        // so a checkout booked while the dialog was open cannot compound
        // with it.
        //
        // `expectedTotal` goes with the stock-take ALONE. A count is a
        // statement about one observed total, so it has to be refused when the
        // total moved under it. A Wareneingang is not: three boxes arrived
        // whatever the shelf did in the meantime. This list is fetched on
        // mount and on search — no polling, no SSE — so a tablet left open on
        // this page all morning holds figures that are hours old, and sending
        // them as a lock turned every perfectly valid delivery into a 409.
        const request: StockAdjustmentInput =
          payload.kind === "inventory"
            ? {
                kind: "inventory",
                targetTotal: payload.new_total,
                reason: payload.reason,
                expectedTotal: row.stock_total,
              }
            : {
                kind: payload.kind,
                quantity: payload.amount,
                reason: payload.reason,
              };
        const snapshot = await adjustArticleStock(token, row.article_id, request);
        applyStockSnapshot(snapshot);
        setBestandId(null);
        /* Read off the request that was actually sent, not off `row`: the lock
         * is the only thing that makes a before-figure worth anything here.
         * A 200 on a request carrying `expectedTotal` means the server
         * compared it with its own `stock_total` and found them equal — so it
         * is the server's before-figure too, and after − before is a real
         * delta. Without the lock there is no before-figure at all, and the
         * notice says what was booked instead of subtracting a number that
         * may be hours old. */
        const confirmedTotalBefore = request.expectedTotal ?? null;
        setNotice(
          stockAdjustmentNotice(
            {
              kind: payload.kind,
              itemName: row.item_name,
              amount: payload.amount,
              confirmedTotalBefore,
              totalAfter: snapshot.stock_total,
              availableAfter: snapshot.stock_available,
            },
            de,
          ),
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        // A 409 means the article moved while the dialog was open, so the
        // numbers it is showing are the ones the server just called stale.
        // Refetching puts the truth in front of the user, in the still-open
        // dialog, next to the message explaining it — which is also why the
        // server's "please reopen the dialog" cannot be passed through as it
        // stands: nothing here closes anything. See `staleStockMessage`.
        const stale = err instanceof ApiError && err.status === 409;
        setBestandError(stale ? staleStockMessage(detail, de) : detail);
        if (stale) await reload();
      } finally {
        setSaving(false);
      }
    },
    [saving, token, applyStockSnapshot, setNotice, de, reload],
  );

  if (mainView !== "werkstatt" || werkstattTab !== "inventar") return null;


  const categoryOptions = Array.from(new Set(allRows.map((r) => r.category))).sort();
  const locationOptions = Array.from(new Set(allRows.map((r) => r.location))).sort();

  return (
    <section className="werkstatt-tab-page">
      <header className="werkstatt-sub-head">
        <div className="werkstatt-sub-head-text">
          <span className="werkstatt-sub-breadcrumb">
            {de ? "WERKSTATT › INVENTAR" : "WORKSHOP › INVENTORY"}
          </span>
          <h1 className="werkstatt-sub-title">
            {de ? "Alle Artikel" : "All items"}
          </h1>
        </div>
        <div className="werkstatt-sub-actions">
          <button type="button" className="werkstatt-action-btn">
            {de ? "Exportieren" : "Export"}
          </button>
          <button
            type="button"
            className="werkstatt-action-btn werkstatt-action-btn--primary"
            onClick={() => setNeuerArtikelOpen(true)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            {de ? "Neuer Artikel" : "New item"}
          </button>
        </div>
      </header>

      <div className="werkstatt-filter-bar">
        <div className="werkstatt-search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="11" cy="11" r="6.3" stroke="#5C7895" strokeWidth="1.8" />
            <path d="m15.6 15.6 4 4" stroke="#5C7895" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={
              de
                ? "Nach Name, Artikelnummer, Lagerort oder Kategorie suchen…"
                : "Search by name, number, location or category…"
            }
          />
        </div>
        <label className="werkstatt-select">
          <span className="werkstatt-select-label">
            {de ? "Kategorie:" : "Category:"}
          </span>
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="all">{de ? "Alle" : "All"}</option>
            {categoryOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label className="werkstatt-select">
          <span className="werkstatt-select-label">
            {de ? "Lagerort:" : "Location:"}
          </span>
          <select value={location} onChange={(event) => setLocation(event.target.value)}>
            <option value="all">{de ? "Alle" : "All"}</option>
            {locationOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <div className="werkstatt-segmented werkstatt-segmented--fill" role="tablist">
          {filters.map((def) => (
            <button
              key={def.key}
              type="button"
              role="tab"
              aria-selected={activeFilter === def.key}
              className={`werkstatt-segmented-btn${activeFilter === def.key ? " werkstatt-segmented-btn--active" : ""}`}
              onClick={() => setActiveFilter(def.key)}
            >
              {(de ? def.label_de : def.label_en)} · {def.count}
            </button>
          ))}
        </div>
      </div>

      <div className="werkstatt-table-card">
        <div className="werkstatt-table-head" role="row">
          <span className="werkstatt-col werkstatt-col-checkbox" />
          <span className="werkstatt-col werkstatt-col-item">
            {de ? "ARTIKEL" : "ITEM"}
          </span>
          <span className="werkstatt-col werkstatt-col-category">
            {de ? "KATEGORIE" : "CATEGORY"}
          </span>
          <span className="werkstatt-col werkstatt-col-location">
            {de ? "LAGERORT" : "LOCATION"}
          </span>
          <span className="werkstatt-col werkstatt-col-stock">
            {de ? "BESTAND" : "STOCK"}
          </span>
          <span className="werkstatt-col werkstatt-col-out">
            {de ? "UNTERWEGS" : "OUT"}
          </span>
          <span className="werkstatt-col werkstatt-col-actions" />
        </div>

        {labelNotice && (
          <p className="werkstatt-label-notice" role="status">
            {labelNotice}
            <button
              type="button"
              className="werkstatt-label-notice-close"
              aria-label={de ? "Hinweis schließen" : "Dismiss"}
              onClick={() => setLabelNotice("")}
            >
              ×
            </button>
          </p>
        )}
        <ul className="werkstatt-table-body">
          {rows.map((row) => (
            <li
              key={row.id}
              className="werkstatt-row werkstatt-row--clickable"
              role="row"
              onClick={(event) => {
                // Row click opens Entnehmen, BUT don't hijack clicks on the
                // checkbox / overflow button / other interactive children.
                const target = event.target as HTMLElement;
                if (target.closest("input, button")) return;
                setEntnehmenError(null);
                setEntnehmenId(row.article_id);
              }}
            >
              <span className="werkstatt-col werkstatt-col-checkbox">
                <input type="checkbox" aria-label={row.item_name} />
              </span>
              <span className="werkstatt-col werkstatt-col-item">
                <span className="werkstatt-row-thumb" aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Z"
                      stroke="#5C7895"
                      strokeWidth="1.6"
                      strokeLinejoin="round"
                    />
                    <path d="M3 7.5 12 12l9-4.5M12 12v9" stroke="#5C7895" strokeWidth="1.6" />
                  </svg>
                </span>
                <span className="werkstatt-row-main">
                  <b className="werkstatt-row-name">{row.item_name}</b>
                  <small className="werkstatt-row-meta">
                    {row.article_no} · {row.sub_meta}
                  </small>
                </span>
              </span>
              <span className="werkstatt-col werkstatt-col-category">{row.category}</span>
              <span className="werkstatt-col werkstatt-col-location">{row.location}</span>
              <span className="werkstatt-col werkstatt-col-stock">
                <span className={`werkstatt-stock-pill werkstatt-stock-pill--${row.stock_tone}`}>
                  <span className="werkstatt-stock-pill-dot" aria-hidden="true" />
                  {row.stock_label}
                </span>
              </span>
              <span className="werkstatt-col werkstatt-col-out">
                {row.out_initials ? (
                  <span className="werkstatt-initials" aria-hidden="true">
                    {row.out_initials}
                  </span>
                ) : (
                  <span className="werkstatt-initials werkstatt-initials--empty" aria-hidden="true" />
                )}
                <span className="werkstatt-row-out-label">{row.out_label}</span>
              </span>
              <span className="werkstatt-col werkstatt-col-actions">
                {/* Unscannable stock is the actionable case, so that button is
                    the prominent one; for everything else this is a reprint. */}
                <button
                  type="button"
                  className={`werkstatt-row-label-btn${row.scannable ? "" : " is-missing"}`}
                  disabled={printingId !== null}
                  aria-label={
                    row.scannable
                      ? de ? "Etikett erneut drucken" : "Reprint label"
                      : de ? "Etikett drucken – Artikel ist nicht scannbar" : "Print label – article is not scannable"
                  }
                  title={
                    row.scannable
                      ? de ? "Etikett erneut drucken" : "Reprint label"
                      : de ? "Kein Barcode – Etikett drucken" : "No barcode – print a label"
                  }
                  onClick={() => void handlePrintLabel(row)}
                >
                  {printingId === row.article_id ? "…" : "⎙"}
                </button>
                {/* Hidden without `werkstatt:manage`: the endpoint behind it
                    requires that permission, and a button that can only end
                    in a 403 is worse than no button — it costs a filled-in
                    dialog to find out. */}
                {canManageStock && (
                  <button
                    type="button"
                    className="werkstatt-row-overflow"
                    aria-label={de ? "Bestand anpassen" : "Adjust stock"}
                    title={de ? "Bestand anpassen" : "Adjust stock"}
                    onClick={() => {
                      setBestandError(null);
                      setBestandId(row.article_id);
                    }}
                  >
                    …
                  </button>
                )}
              </span>
            </li>
          ))}
          {rows.length === 0 && loading && (
            <li className="werkstatt-row werkstatt-row--empty muted">
              {de ? "Artikel werden geladen…" : "Loading articles…"}
            </li>
          )}
          {/* A failed request must never render as "no articles" — that reads
              as an empty warehouse and is exactly how this page shipped
              showing nothing while production held 249 articles. */}
          {rows.length === 0 && !loading && loadError && (
            <li className="werkstatt-row werkstatt-row--empty" role="alert">
              {de
                ? "Bestand konnte nicht geladen werden — das heißt nicht, dass kein Bestand da ist."
                : "Stock could not be loaded — that does not mean there is none."}{" "}
              <button type="button" className="werkstatt-card-action" onClick={() => void reload()}>
                {de ? "Erneut versuchen" : "Try again"}
              </button>
            </li>
          )}
          {rows.length === 0 && !loading && !loadError && (
            <li className="werkstatt-row werkstatt-row--empty muted">
              {de ? "Keine Artikel für die aktuelle Auswahl." : "No items match the current filter."}
            </li>
          )}
        </ul>
      </div>

      {/* Modals */}
      <NeuerArtikelModal
        open={neuerArtikelOpen}
        onClose={() => setNeuerArtikelOpen(false)}
        language={language}
        onSave={(payload) => {
          // TODO(werkstatt): POST /api/werkstatt/articles.
          //
          // Until that exists, this saves NOTHING — and says so. It used to
          // report "gespeichert (API folgt)" in the green success toast, which
          // next to two dialogs that now really do book stock is a lie the
          // user has no way to catch. The error toast is the honest channel:
          // they pressed save and nothing was stored. The dialog stays open so
          // what they typed is still there to copy out.
          setError(
            de
              ? `Neue Artikel können noch nicht angelegt werden — "${payload.item_name || "Neuer Artikel"}" wurde NICHT gespeichert.`
              : `Creating articles is not wired up yet — "${payload.item_name || "New item"}" was NOT saved.`,
          );
        }}
      />

      {/* Both dialogs are handed the row's REAL counters. They used to get the
          constants 3 and 4, which is why every article in the workshop opened
          claiming to hold four. */}
      {entnehmenRow && (
        <EntnehmenModal
          open={true}
          onClose={() => {
            setEntnehmenId(null);
            setEntnehmenError(null);
          }}
          language={language}
          article={{
            item_name: entnehmenRow.item_name,
            article_number: entnehmenRow.article_no,
            location_name: entnehmenRow.location,
            stock_available: entnehmenRow.stock_available,
            stock_total: entnehmenRow.stock_total,
          }}
          projects={projects.map((p) => ({
            id: String(p.id),
            number: p.project_number,
            title: p.name,
          }))}
          submitting={saving}
          error={entnehmenError}
          onConfirm={(payload) => void handleCheckout(entnehmenRow, payload)}
        />
      )}

      {bestandRow && (
        <BestandAnpassenModal
          open={true}
          onClose={() => {
            setBestandId(null);
            setBestandError(null);
          }}
          language={language}
          article={{
            item_name: bestandRow.item_name,
            article_number: bestandRow.article_no,
            category_name: bestandRow.category,
            stock_total: bestandRow.stock_total,
            stock_available: bestandRow.stock_available,
            unit: bestandRow.unit,
          }}
          submitting={saving}
          error={bestandError}
          onConfirm={(payload) => void handleAdjustStock(bestandRow, payload)}
        />
      )}
    </section>
  );
}
