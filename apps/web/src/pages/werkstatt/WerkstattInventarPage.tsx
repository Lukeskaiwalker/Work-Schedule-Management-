import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppContext } from "../../context/AppContext";
import { ApiError } from "../../api/client";
import { useBarcodeScanner } from "../../hooks/useBarcodeScanner";
import { useKeptRow } from "../../hooks/useKeptRow";
import { unitLabel } from "../../components/werkstatt/unitLabel";
import { NeuerArtikelModal } from "../../components/werkstatt/NeuerArtikelModal";
import { ArtikelBearbeitenModal } from "../../components/werkstatt/ArtikelBearbeitenModal";
import { DuplikateModal } from "../../components/werkstatt/DuplikateModal";
import { EntnehmenModal } from "../../components/werkstatt/EntnehmenModal";
import { BestandAnpassenModal } from "../../components/werkstatt/BestandAnpassenModal";
import {
  StockFilterBar,
  type StockFilterDef,
  type StockFilterKey,
} from "../../components/werkstatt/StockFilterBar";
import { StockTableRow } from "../../components/werkstatt/StockTableRow";
import { type MockInventoryRow, type MockStockTone } from "../../components/werkstatt/mockData";
import {
  adjustArticleStock,
  checkoutArticle,
  getArticle,
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
import {
  CSV_BOM,
  stockExportFilename,
  stockRowsToCsv,
} from "../../components/werkstatt/stockExport";
import {
  DUPLICATE_PAGE_LIMIT,
  listDuplicateCandidates,
} from "../../utils/werkstattDuplicatesApi";
import { lookupArticleCode } from "../../utils/werkstattArticleLookupApi";
import { expectedReturnIso } from "../../utils/werkstattReturnDates";
import "../../styles/stock.css";

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
 * External HID barcode scans are routed through useBarcodeScanner. A scan
 * outside any input puts the code in the search box and resolves it against
 * SMPL's own rows only (no webshop — this fires on every scan): a hit leaves
 * the filtered list showing it, a miss opens the create dialog with the code
 * already in hand, which is the whole point of scanning at a desk.
 */
/**
 * What the "Bestand anpassen" dialog needs to know about an article.
 *
 * Narrower than a table row on purpose: the dialog is also opened for articles
 * that are NOT in the table — a machine type, or anything the current filter
 * excludes — and a row is the wrong thing to demand there. `MockInventoryRow`
 * satisfies it structurally, so the table path is unchanged.
 */
type StockDialogSubject = {
  article_id: number;
  article_no: string;
  item_name: string;
  category: string;
  stock_total: number;
  stock_available: number;
  unit: string | null;
};

export function WerkstattInventarPage() {
  const {
    mainView,
    language,
    werkstattTab,
    setWerkstattTab,
    projects,
    setNotice,
    setError,
    token,
    user,
  } = useAppContext();

  /* The movements endpoint is gated on `werkstatt:manage`. Offering the
   * dialog to everyone meant an apprentice could pick a kind, type a count and
   * write a Beleg number, and learn only from a 403 that none of it was ever
   * going to be booked. Mirrors the server's gate exactly, `?? []` so an
   * unloaded user is treated as holding nothing rather than everything. */
  const canManageStock = (user?.effective_permissions ?? []).includes("werkstatt:manage");

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [location, setLocation] = useState<string>("all");
  const [activeFilter, setActiveFilter] = useState<StockFilterKey>("all");
  const [articles, setArticles] = useState<WerkstattArticleLite[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  /* Modal state — each modal gets its own slot; Entnehmen + BestandAnpassen
   * hold the row the user is acting on (null when closed). */
  const [neuerArtikelOpen, setNeuerArtikelOpen] = useState(false);
  /* A code the create dialog should resolve on open — set when a scan landed
   * on this page and found nothing, so the dialog starts from what was
   * scanned instead of asking for it again. */
  const [neuerArtikelCode, setNeuerArtikelCode] = useState<string | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const [editArchiveFirst, setEditArchiveFirst] = useState(false);
  const [duplicatesOpen, setDuplicatesOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [duplicateCount, setDuplicateCount] = useState<number | null>(null);
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

  /* A scan on this page used to be dropped into the search box, which is a
   * fine signal and a poor answer: the common case at a desk is a code for
   * something not stocked yet, and searching for it shows an empty list. The
   * code is now resolved — cheaply, `allowExternal: false`, because this fires
   * on every scan and the external half can make the server fetch a product
   * page. A hit narrows the list to the article the lookup actually matched
   * (by ITS number, not by the raw scan: a 13-digit scan against a stored
   * 12-digit UPC-A would otherwise leave an empty list with the code in the
   * box and no explanation). A miss opens the create dialog with the code
   * already in hand. */
  useBarcodeScanner({
    /* Disarmed while ANY of this page's dialogs is open. The scanner is armed
     * for the whole tab and `useBarcodeScanner` only suppresses itself while
     * focus sits in a text field — so after the create dialog reaches its
     * "Treffer" step (buttons only) a scan from the bench re-seeded the dialog
     * and replaced every field the person had typed. Nothing on any of these
     * dialogs reads a scan, so listening for one there buys nothing. */
    enabled:
      mainView === "werkstatt" &&
      werkstattTab === "inventar" &&
      entnehmenId === null &&
      bestandId === null &&
      editId === null &&
      !neuerArtikelOpen &&
      !duplicatesOpen,
    onScan: (code) => {
      setSearch(code);
      void lookupArticleCode(token, code, { allowExternal: false })
        .then((found) => {
          if (found.kind === "existing") {
            // The row's own number always matches the list's search; the
            // spelling on the sticker may not.
            setSearch(found.article.article_number);
            return;
          }
          setNeuerArtikelCode(code);
          setNeuerArtikelOpen(true);
        })
        .catch(() => {
          // The search box already holds the code; a failed lookup must not
          // take that away, and there is nothing else to say about it.
        });
    },
  });

  const active = mainView === "werkstatt" && werkstattTab === "inventar";

  const reload = useCallback(async () => {
    if (!active) return;
    setLoading(true);
    try {
      // Server-side search: the article table grows with every stock-take, so
      // fetching everything and filtering here would fail quietly as it grows.
      // Consumables only. The Bestand page is "what we use up"; machine
      // TYPES live in the Maschinen tab, where units carry their own labels
      // and inspection dates. Filtered server-side so the counts under the
      // filter chips describe the list somebody is actually looking at.
      const rows = await listArticles(token, {
        q: search.trim() || undefined,
        kind: "consumable",
        // Archived rows are out of the way by default and reachable on
        // demand: "Archivieren" promises the article can be brought back, and
        // without this there was no list it could be brought back FROM — the
        // EAN-clash message telling somebody to go and reactivate SP-0042
        // named a row no screen could open.
        includeArchived: showArchived,
        limit: 500,
      });
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
  }, [active, token, search, showArchived]);

  useEffect(() => {
    const timer = window.setTimeout(() => void reload(), search ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [reload, search]);

  /* The duplicate scan is an O(n²) name comparison server-side, so it runs
   * when the tab is opened and never while somebody types. The badge is the
   * only thing that makes the review queue discoverable — without it the
   * feature is a button nobody has a reason to press. */
  const loadDuplicateCount = useCallback(async () => {
    if (!active || !canManageStock) return;
    try {
      // The SAME limit the dialog asks for. A badge counted to 200 over a list
      // capped at 50 promised work the screen could not show, and left a badge
      // reading 13 with nothing to act on.
      setDuplicateCount((await listDuplicateCandidates(token, DUPLICATE_PAGE_LIMIT)).length);
    } catch {
      // A failed count hides the badge rather than claiming zero: "no
      // duplicates" is a finding, and this is not one.
      setDuplicateCount(null);
    }
  }, [active, canManageStock, token]);

  useEffect(() => {
    void loadDuplicateCount();
  }, [loadDuplicateCount]);

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
          // Only ever true while "Archivierte anzeigen" is on.
          is_archived: Boolean(a.is_archived),
        };
      }),
    [articles, language],
  );

  const counts = useMemo(() => {
    const by: Record<MockStockTone, number> = { available: 0, low: 0, empty: 0, out: 0 };
    for (const row of allRows) by[row.stock_tone] += 1;
    return by;
  }, [allRows]);

  const filters: ReadonlyArray<StockFilterDef> = useMemo(
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

  /* The create dialog's "Bereits im Bestand" card can name an article this
   * list does not contain — a filtered list, or a machine type (the list is
   * fetched with kind="consumable"). Deriving the dialog's subject from the
   * list alone meant the create dialog closed, no dialog opened, and nothing
   * was said: the person pressed the one button the card told them they
   * wanted and the screen went back to the list. So: fetch it by id. */
  const [bestandFetched, setBestandFetched] = useState<StockDialogSubject | null>(null);
  useEffect(() => {
    if (bestandId === null || bestandRow !== null) {
      setBestandFetched(null);
      return;
    }
    let cancelled = false;
    void getArticle(token, bestandId)
      .then((article) => {
        if (cancelled) return;
        setBestandFetched({
          article_id: article.id,
          article_no: article.article_number,
          item_name: article.item_name,
          category: article.category_name ?? "—",
          stock_total: article.stock_total,
          stock_available: article.stock_available,
          unit: article.unit,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setBestandFetched(null);
        setBestandError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [bestandId, bestandRow, token]);

  const bestandSubject: StockDialogSubject | null = bestandRow ?? bestandFetched;

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
      row: StockDialogSubject,
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
        if (stale) {
          await reload();
          // A subject that came from `getArticle` is not in the list, so the
          // refetch above cannot refresh it — and the whole point of a 409 is
          // that the figures on screen are the ones the server just called
          // stale. Ask for its row again by id.
          const fresh = await getArticle(token, row.article_id).catch(() => null);
          if (fresh) {
            setBestandFetched((prev) =>
              prev === null || prev.article_id !== fresh.id
                ? prev
                : {
                    ...prev,
                    stock_total: fresh.stock_total,
                    stock_available: fresh.stock_available,
                  },
            );
          }
        }
      } finally {
        setSaving(false);
      }
    },
    [saving, token, applyStockSnapshot, setNotice, de, reload],
  );

  if (mainView !== "werkstatt" || werkstattTab !== "inventar") return null;

  /** Download the FILTERED rows. The button sits beside the filters, so the
   *  narrowed list is what somebody pressing it means. */
  function exportCsv() {
    const blob = new Blob([CSV_BOM + stockRowsToCsv(rows, de)], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = stockExportFilename(new Date());
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    /* Deferred: Safari — the browser on the workshop iPad — fetches the blob
     * AFTER the click handler returns, so revoking in the same tick yielded
     * nothing and no file was saved, while the notice below still claimed one
     * had been. A tick is enough for every engine to have taken it. */
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setNotice(
      de
        ? `${rows.length} Artikel exportiert.`
        : `Exported ${rows.length} articles.`,
    );
  }


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
          <small className="muted">
            {de
              ? "Verbrauchs- und Lagerartikel — Maschinen unter „Maschinen“"
              : "Consumables and stock items — machines live under “Machines”"}
          </small>
        </div>
        <div className="werkstatt-sub-actions">
          {canManageStock && (
            <button
              type="button"
              className="werkstatt-action-btn"
              onClick={() => setDuplicatesOpen(true)}
            >
              {de ? "Duplikate prüfen" : "Review duplicates"}
              {duplicateCount != null && duplicateCount > 0 && (
                <span className="stock-badge">{duplicateCount}</span>
              )}
            </button>
          )}
          <button
            type="button"
            className="werkstatt-action-btn"
            disabled={rows.length === 0}
            onClick={exportCsv}
          >
            {de ? "Exportieren" : "Export"}
          </button>
          {/* Behind the same gate as the row menu, and for the reason stated
              there: POST /werkstatt/articles requires `werkstatt:manage`, so
              without it this button can only end in a 403 — after somebody
              has scanned a code, checked a webshop suggestion, picked a
              Lagerort and typed a Startbestand. A sentence naming who can do
              it is worth more than a dialog that throws the work away. */}
          {canManageStock ? (
            <button
              type="button"
              className="werkstatt-action-btn werkstatt-action-btn--primary"
              onClick={() => {
                setNeuerArtikelCode(null);
                setNeuerArtikelOpen(true);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              {de ? "Neuer Artikel" : "New item"}
            </button>
          ) : (
            <small className="muted">
              {de
                ? "Neue Artikel legt das Büro an (Berechtigung „Werkstatt verwalten“)."
                : "New items are created by the office (permission “manage workshop”)."}
            </small>
          )}
        </div>
      </header>

      <StockFilterBar
        de={de}
        search={search}
        onSearch={setSearch}
        category={category}
        categoryOptions={categoryOptions}
        onCategory={setCategory}
        location={location}
        locationOptions={locationOptions}
        onLocation={setLocation}
        showArchived={showArchived}
        onShowArchived={setShowArchived}
        filters={filters}
        activeFilter={activeFilter}
        onFilter={setActiveFilter}
      />

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
            <StockTableRow
              key={row.id}
              row={row}
              de={de}
              printingId={printingId}
              canManage={canManageStock}
              onCheckout={(articleId) => {
                setEntnehmenError(null);
                setEntnehmenId(articleId);
              }}
              onAdjustStock={(articleId) => {
                setBestandError(null);
                setBestandId(articleId);
              }}
              onEdit={(articleId) => {
                setEditArchiveFirst(false);
                setEditId(articleId);
              }}
              onArchive={(articleId) => {
                setEditArchiveFirst(true);
                setEditId(articleId);
              }}
              onPrintLabel={(target) => void handlePrintLabel(target)}
            />
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
        onClose={() => {
          setNeuerArtikelOpen(false);
          setNeuerArtikelCode(null);
        }}
        language={language}
        token={token}
        seedCode={neuerArtikelCode}
        onCreated={(article) => {
          setNotice(
            de
              ? `${article.article_number} „${article.item_name}“ angelegt`
              : `${article.article_number} “${article.item_name}” created`,
          );
          /* An article with no EAN cannot be found by scanning anything, so
           * the next useful step is a shelf label — said once, here, rather
           * than discovered weeks later at the rack. */
          if (!article.ean) {
            setLabelNotice(
              de
                ? `${article.article_number} hat keinen Barcode — Etikett drucken?`
                : `${article.article_number} has no barcode — print a label?`,
            );
          }
          setNeuerArtikelCode(null);
          void reload();
          void loadDuplicateCount();
        }}
        onAdjustStock={(articleId) => {
          setBestandError(null);
          setBestandId(articleId);
        }}
        onEditArticle={(articleId) => {
          setEditArchiveFirst(false);
          setEditId(articleId);
        }}
      />

      <ArtikelBearbeitenModal
        open={editId !== null}
        articleId={editId}
        language={language}
        token={token}
        startArchiveConfirm={editArchiveFirst}
        onClose={() => {
          setEditId(null);
          setEditArchiveFirst(false);
        }}
        onSaved={(article) => {
          setNotice(
            de
              ? `${article.article_number} gespeichert`
              : `${article.article_number} saved`,
          );
          void reload();
        }}
        onArchived={(article) => {
          setNotice(
            de
              ? `${article.article_number} „${article.item_name}“ archiviert`
              : `${article.article_number} “${article.item_name}” archived`,
          );
          void reload();
          void loadDuplicateCount();
        }}
        onOpenStockDialog={(articleId) => {
          setEditId(null);
          setBestandError(null);
          setBestandId(articleId);
        }}
        onOpenMachines={() => {
          setEditId(null);
          setWerkstattTab("maschinen");
        }}
      />

      <DuplikateModal
        open={duplicatesOpen}
        language={language}
        token={token}
        onClose={() => setDuplicatesOpen(false)}
        onMerged={(message) => {
          setNotice(message);
          void reload();
          void loadDuplicateCount();
        }}
        onError={(message) => setError(message)}
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

      {bestandSubject && (
        <BestandAnpassenModal
          open={true}
          onClose={() => {
            setBestandId(null);
            setBestandError(null);
          }}
          language={language}
          article={{
            item_name: bestandSubject.item_name,
            article_number: bestandSubject.article_no,
            category_name: bestandSubject.category,
            stock_total: bestandSubject.stock_total,
            stock_available: bestandSubject.stock_available,
            unit: bestandSubject.unit,
          }}
          submitting={saving}
          error={bestandError}
          onConfirm={(payload) => void handleAdjustStock(bestandSubject, payload)}
        />
      )}
      {/* The id is set, the list does not hold it and the fetch failed: say so
          rather than leaving the person looking at a list that just closed a
          dialog on them. */}
      {bestandId !== null && bestandSubject === null && bestandError && (
        <p className="werkstatt-label-notice" role="alert">
          {bestandError}
          <button
            type="button"
            className="werkstatt-label-notice-close"
            aria-label={de ? "Hinweis schließen" : "Dismiss"}
            onClick={() => {
              setBestandId(null);
              setBestandError(null);
            }}
          >
            ×
          </button>
        </p>
      )}
    </section>
  );
}
