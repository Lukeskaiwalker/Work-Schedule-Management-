/**
 * Baustellenkisten (construction boxes) — rack overview + phone-first packing.
 *
 * ONE responsive page rather than a desktop/mobile pair: packing happens on a
 * phone in the warehouse, assignment happens at a desk, but both need the same
 * box list.
 *
 * Layout follows the shared Werkstatt design system (`werkstatt-sub-head`,
 * `werkstatt-kpi-strip`, `werkstatt-card` + `werkstatt-card-head`,
 * `werkstatt-content-grid`) rather than bare cards. `.werkstatt-card` carries
 * NO padding of its own — content must sit inside a head/body wrapper, which is
 * why an earlier version of this page appeared to overflow its own card edges.
 *
 * The rack grid mirrors the physical arrangement of the eight permanent
 * workshop boxes so the number on screen is the number painted on the crate.
 *
 * Packing UX differs deliberately from the construction-report material grid
 * (which the product owner referenced as the model, "but easier from a phone"):
 *   * one search field that resolves against BOTH stocked articles and the
 *     Datanorm catalog, instead of typing an article number blind,
 *   * a hardware/Bluetooth barcode scanner that works while that field is
 *     focused (the hook ignores typing by default — see ignoreWhenTyping below),
 *   * tap +/- quantity instead of a numeric text input,
 *   * a repeat scan of the same article tops up its line rather than adding a
 *     duplicate row.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiFetch } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import { useBarcodeScanner } from "../../hooks/useBarcodeScanner";
import { CustomerCombobox } from "../../components/customers/CustomerCombobox";
import {
  CameraScannerSheet,
  type ScanOutcome,
} from "../../components/werkstatt/CameraScannerSheet";
import { formatServerDateTime } from "../../utils/dates";

type BoxItem = {
  id: number;
  box_id: number;
  source: string;
  article_id: number | null;
  catalog_external_key: string | null;
  item_name: string;
  article_no: string | null;
  ean: string | null;
  unit: string | null;
  quantity: number;
  notes: string | null;
};

type Box = {
  id: number;
  box_number: string;
  label: string;
  /** 1..8 for the permanent rack boxes, null for ad-hoc ones. */
  slot: number | null;
  status: string;
  customer_id: number | null;
  customer_name: string | null;
  project_id: number | null;
  project_name: string | null;
  item_count: number;
  packed_at: string | null;
  assigned_at: string | null;
  returned_at: string | null;
  notes: string | null;
  items: BoxItem[];
};

type SearchHit = {
  source: "article" | "catalog" | "manual";
  article_id: number | null;
  catalog_external_key: string | null;
  item_name: string;
  article_no: string | null;
  ean: string | null;
  unit: string | null;
  stock_available: number | null;
  /** Anything but "partial" is an exact hit on a scannable identifier. */
  match: "exact_ean" | "exact_article_no" | "exact_supplier_no" | "partial";
  supplier_name: string | null;
  supplier_article_no: string | null;
};

const STATUS_LABELS: Record<string, { de: string; en: string }> = {
  offen: { de: "Offen", en: "Open" },
  gepackt: { de: "Gepackt", en: "Packed" },
  zugewiesen: { de: "Beim Kunden", en: "With customer" },
  zurueck: { de: "Zurück", en: "Returned" },
};

/**
 * Geometry of the physical rack, straight off the workshop photo: boxes 1 and 2
 * are the two full-height crates on the left, 3 and 4 the deep ones underneath,
 * 5–8 the small ones stacked on the right.
 *
 * This is presentation only — the backend stores nothing but the slot number
 * (see STANDARD_BOX_SLOTS in services/werkstatt_boxes.py), so re-arranging the
 * rack is a change to this constant and the matching CSS grid-areas, with no
 * migration.
 */
const RACK_SIZES: Record<number, "gross" | "mittel" | "klein"> = {
  1: "gross",
  2: "gross",
  3: "mittel",
  4: "mittel",
  5: "klein",
  6: "klein",
  7: "klein",
  8: "klein",
};

const SIZE_LABELS: Record<string, { de: string; en: string }> = {
  gross: { de: "groß", en: "large" },
  mittel: { de: "mittel", en: "medium" },
  klein: { de: "klein", en: "small" },
};

const RACK_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="6.3" stroke="#5C7895" strokeWidth="1.8" />
      <path d="m15.6 15.6 4 4" stroke="#5C7895" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 8.5h3l1.5-2.5h7L17 8.5h3v10H4v-10Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="13" r="3.2" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

export function WerkstattKistenPage() {
  const { mainView, werkstattTab, language, token, setError, setNotice, customers } =
    useAppContext();
  const de = language === "de";

  const [boxes, setBoxes] = useState<Box[]>([]);
  const [activeBox, setActiveBox] = useState<Box | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [assignCustomerId, setAssignCustomerId] = useState<number | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  /** Serialises scan handling — see runScan. */
  const scanQueueRef = useRef<Promise<unknown>>(Promise.resolve());

  const isActiveTab = mainView === "werkstatt" && werkstattTab === "kisten";
  // A handed-over box has its contents frozen server-side; every write control
  // is hidden. Computed up here because the scanner hooks below need it too.
  const locked = activeBox?.status === "zugewiesen";

  const loadBoxes = useCallback(async () => {
    setLoading(true);
    try {
      setBoxes(await apiFetch<Box[]>("/werkstatt/boxes", token));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [token, setError]);

  const openBox = useCallback(
    async (boxId: number) => {
      try {
        const box = await apiFetch<Box>(`/werkstatt/boxes/${boxId}`, token);
        setActiveBox(box);
        setAssignCustomerId(box.customer_id);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [token, setError],
  );

  useEffect(() => {
    if (!isActiveTab) return;
    void loadBoxes();
  }, [isActiveTab, loadBoxes]);

  // Debounced unified search across stocked articles + Datanorm catalog.
  useEffect(() => {
    if (!activeBox || !search.trim()) {
      setHits([]);
      return;
    }
    const handle = window.setTimeout(async () => {
      try {
        setHits(
          await apiFetch<SearchHit[]>(
            `/werkstatt/item-search?q=${encodeURIComponent(search.trim())}`,
            token,
          ),
        );
      } catch {
        setHits([]);
      }
    }, 250);
    return () => window.clearTimeout(handle);
  }, [search, activeBox, token]);

  /** Returns whether the line actually landed — callers must not assume. */
  const addItem = useCallback(
    async (payload: Record<string, unknown>): Promise<boolean> => {
      if (!activeBox) return false;
      try {
        await apiFetch(`/werkstatt/boxes/${activeBox.id}/items`, token, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        await openBox(activeBox.id);
        setSearch("");
        setHits([]);
        return true;
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [activeBox, token, openBox, setError],
  );

  /**
   * Resolve a scanned code and add it.
   *
   * Goes through /werkstatt/item-search, which covers the same identifiers as
   * the mobile scan cascade — EAN, our SP-number, and the supplier's own
   * article number (Unielektro et al.) — plus the Datanorm catalog, and ranks
   * exact identifier hits first.
   *
   * Reports the OUTCOME rather than assuming success: the camera sheet covers
   * the app-level error banner, so a failed add has to be visible in the sheet.
   */
  const handleScan = useCallback(
    async (code: string): Promise<ScanOutcome> => {
      if (!activeBox || locked) {
        return { ok: false, label: de ? "Kiste gesperrt" : "Box locked" };
      }
      try {
        const hitList = await apiFetch<SearchHit[]>(
          `/werkstatt/item-search?q=${encodeURIComponent(code)}`,
          token,
        );
        // Auto-add ONLY on an unambiguous exact identifier hit (EAN, our
        // SP-number, or a supplier's own article number). Taking hitList[0]
        // blindly would let a substring match on an unrelated article end up
        // physically in the crate.
        const exactHits = hitList.filter((hit) => hit.match !== "partial");
        if (exactHits.length !== 1) {
          if (hitList.length === 0) {
            setError(de ? `Kein Artikel zu "${code}" gefunden` : `No item found for "${code}"`);
            return { ok: false, label: de ? `Unbekannt: ${code}` : `Unknown: ${code}` };
          }
          // Ambiguous: show the candidates instead of guessing. Filling the
          // search field means the list is already there when the sheet closes.
          setSearch(code);
          return {
            ok: false,
            label: de
              ? `${hitList.length} Treffer — bitte auswählen`
              : `${hitList.length} matches — pick one`,
          };
        }
        const first = exactHits[0];
        const added = await addItem({
          source: first.source,
          article_id: first.article_id,
          catalog_external_key: first.catalog_external_key,
          item_name: first.item_name,
          article_no: first.article_no,
          ean: first.ean,
          unit: first.unit,
          quantity: 1,
        });
        if (!added) {
          return { ok: false, label: `${de ? "Fehler" : "Failed"}: ${first.item_name}` };
        }
        setNotice(`${first.item_name} +1`);
        return { ok: true, label: `${first.item_name} +1` };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        return { ok: false, label: de ? "Fehler beim Hinzufügen" : "Add failed" };
      }
    },
    [activeBox, locked, token, addItem, setError, setNotice, de],
  );

  /**
   * One scan at a time. Each scan is three round trips (search → POST → refetch
   * the box) and the camera fires again ~400 ms later, so overlapping runs would
   * race on the box refetch and could paint a contents list that is missing the
   * item just added — inviting the packer to scan it twice.
   */
  const runScan = useCallback(
    (code: string): Promise<ScanOutcome> => {
      const next = scanQueueRef.current.then(() => handleScan(code));
      scanQueueRef.current = next.catch(() => undefined);
      return next;
    },
    [handleScan],
  );

  // ignoreWhenTyping:false is REQUIRED here — the hook skips keystrokes while an
  // input is focused, and this screen's whole point is a permanently focused
  // search box. Without it a Bluetooth scanner would silently do nothing.
  // Disabled while the camera sheet is up (it has no focused input, so a
  // hardware scan would be handled twice) and on a handed-over box, where every
  // other write control is already hidden.
  useBarcodeScanner({
    enabled: isActiveTab && activeBox !== null && !locked && !cameraOpen,
    ignoreWhenTyping: false,
    onScan: (code) => void runScan(code),
  });

  const statusLabel = useCallback(
    (status: string) =>
      de ? STATUS_LABELS[status]?.de ?? status : STATUS_LABELS[status]?.en ?? status,
    [de],
  );

  const standardBoxes = useMemo(
    () =>
      new Map(boxes.filter((box) => box.slot !== null).map((box) => [box.slot as number, box])),
    [boxes],
  );
  const adHocBoxes = useMemo(() => boxes.filter((box) => box.slot === null), [boxes]);

  const totals = useMemo(() => {
    const count = (status: string) => boxes.filter((box) => box.status === status).length;
    return {
      open: count("offen"),
      packed: count("gepackt"),
      assigned: count("zugewiesen"),
      returned: count("zurueck"),
    };
  }, [boxes]);

  if (!isActiveTab) return null;

  async function createBox() {
    const label = newLabel.trim();
    if (!label) return;
    try {
      const box = await apiFetch<Box>("/werkstatt/boxes", token, {
        method: "POST",
        body: JSON.stringify({ label }),
      });
      setNewLabel("");
      setCreating(false);
      await loadBoxes();
      await openBox(box.id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function changeQty(item: BoxItem, delta: number) {
    if (!activeBox) return;
    const next = item.quantity + delta;
    try {
      if (next <= 0) {
        await apiFetch(`/werkstatt/boxes/${activeBox.id}/items/${item.id}`, token, {
          method: "DELETE",
        });
      } else {
        await apiFetch(`/werkstatt/boxes/${activeBox.id}/items/${item.id}`, token, {
          method: "PATCH",
          body: JSON.stringify({ quantity: next }),
        });
      }
      await openBox(activeBox.id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function clearBox() {
    if (!activeBox) return;
    const confirmed = window.confirm(
      de
        ? `Alle ${activeBox.items.length} Positionen aus "${activeBox.label}" entfernen?`
        : `Remove all ${activeBox.items.length} items from "${activeBox.label}"?`,
    );
    if (!confirmed) return;
    try {
      await apiFetch(`/werkstatt/boxes/${activeBox.id}/items`, token, { method: "DELETE" });
      await Promise.all([openBox(activeBox.id), loadBoxes()]);
      setNotice(de ? "Kiste geleert" : "Box emptied");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function setStatus(status: string) {
    if (!activeBox) return;
    try {
      await apiFetch(`/werkstatt/boxes/${activeBox.id}/status`, token, {
        method: "POST",
        body: JSON.stringify({ status }),
      });
      await Promise.all([openBox(activeBox.id), loadBoxes()]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function assign() {
    if (!activeBox || assignCustomerId == null) return;
    try {
      await apiFetch(`/werkstatt/boxes/${activeBox.id}/assign`, token, {
        method: "POST",
        body: JSON.stringify({ customer_id: assignCustomerId }),
      });
      setNotice(de ? "Kiste zugewiesen" : "Box assigned");
      await Promise.all([openBox(activeBox.id), loadBoxes()]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /* ── List view ─────────────────────────────────────────────────────────── */

  if (!activeBox) {
    return (
      <section className="werkstatt-tab-page kisten-page">
        <header className="werkstatt-sub-head">
          <div className="werkstatt-sub-head-text">
            <span className="werkstatt-sub-breadcrumb">
              {de ? "WERKSTATT › BAUSTELLENKISTEN" : "WORKSHOP › CONSTRUCTION BOXES"}
            </span>
            <h1 className="werkstatt-sub-title">
              {de ? "Baustellenkisten" : "Construction boxes"}
            </h1>
            <p className="werkstatt-sub-subtitle">
              {de
                ? `${RACK_SLOTS.length} feste Kisten im Regal${
                    adHocBoxes.length > 0 ? ` · ${adHocBoxes.length} Sonderkiste(n)` : ""
                  }`
                : `${RACK_SLOTS.length} permanent boxes in the rack${
                    adHocBoxes.length > 0 ? ` · ${adHocBoxes.length} ad-hoc` : ""
                  }`}
            </p>
          </div>
          <div className="werkstatt-sub-actions">
            <button
              type="button"
              className="werkstatt-action-btn werkstatt-action-btn--primary"
              onClick={() => setCreating((v) => !v)}
            >
              {de ? "Sonderkiste anlegen" : "New ad-hoc box"}
            </button>
          </div>
        </header>

        {creating && (
          <div className="werkstatt-filter-bar">
            <div className="werkstatt-search">
              <SearchIcon />
              <input
                type="text"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder={
                  de ? "Bezeichnung, z. B. Kiste Dachmontage" : "Label, e.g. Roof kit"
                }
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void createBox();
                  }
                }}
              />
            </div>
            <button
              type="button"
              className="werkstatt-action-btn werkstatt-action-btn--primary"
              onClick={() => void createBox()}
              disabled={!newLabel.trim()}
            >
              {de ? "Anlegen" : "Create"}
            </button>
            <button
              type="button"
              className="werkstatt-action-btn"
              onClick={() => {
                setCreating(false);
                setNewLabel("");
              }}
            >
              {de ? "Abbrechen" : "Cancel"}
            </button>
          </div>
        )}

        <div className="werkstatt-kpi-strip">
          <div className="werkstatt-kpi werkstatt-kpi--neutral">
            <span className="werkstatt-kpi-label">{de ? "OFFEN" : "OPEN"}</span>
            <div className="werkstatt-kpi-value-row">
              <span className="werkstatt-kpi-value">{totals.open}</span>
              <span className="werkstatt-kpi-subtitle">{de ? "packbar" : "packable"}</span>
            </div>
          </div>
          <div className="werkstatt-kpi werkstatt-kpi--info">
            <span className="werkstatt-kpi-label">{de ? "GEPACKT" : "PACKED"}</span>
            <div className="werkstatt-kpi-value-row">
              <span className="werkstatt-kpi-value">{totals.packed}</span>
              <span className="werkstatt-kpi-subtitle">
                {de ? "bereit zur Übergabe" : "ready to hand over"}
              </span>
            </div>
          </div>
          <div className="werkstatt-kpi werkstatt-kpi--warning">
            <span className="werkstatt-kpi-label">{de ? "BEIM KUNDEN" : "WITH CUSTOMER"}</span>
            <div className="werkstatt-kpi-value-row">
              <span className="werkstatt-kpi-value">{totals.assigned}</span>
              <span className="werkstatt-kpi-subtitle">{de ? "unterwegs" : "out"}</span>
            </div>
          </div>
          <div className="werkstatt-kpi werkstatt-kpi--danger">
            <span className="werkstatt-kpi-label">{de ? "ZURÜCK" : "RETURNED"}</span>
            <div className="werkstatt-kpi-value-row">
              <span className="werkstatt-kpi-value">{totals.returned}</span>
              <span className="werkstatt-kpi-subtitle">
                {de ? "auszuräumen" : "to unpack"}
              </span>
            </div>
          </div>
        </div>

        <article className="werkstatt-card">
          <header className="werkstatt-card-head">
            <div className="werkstatt-card-title-block">
              <h3 className="werkstatt-card-title">
                {de ? "Standardkisten" : "Standard boxes"}
              </h3>
              <span className="werkstatt-card-subtitle">
                {de
                  ? "Anordnung wie im Regal — die Nummer ist die Aufschrift auf der Kiste"
                  : "Arranged like the rack — the number is what is painted on the crate"}
              </span>
            </div>
          </header>
          <div className="kisten-rack">
            {RACK_SLOTS.map((slot) => {
              const box = standardBoxes.get(slot);
              const size = RACK_SIZES[slot];
              return (
                <button
                  key={`slot-${slot}`}
                  type="button"
                  className={`kisten-slot kisten-slot--pos${slot} kisten-slot--${
                    box ? box.status : "offen"
                  }`}
                  onClick={() => box && void openBox(box.id)}
                  disabled={!box}
                >
                  <span className="kisten-slot-top">
                    <span className="kisten-slot-num">{slot}</span>
                    <span className="kisten-slot-size">
                      {de ? SIZE_LABELS[size].de : SIZE_LABELS[size].en}
                    </span>
                  </span>
                  <span className="kisten-slot-label">
                    {box ? box.label : loading ? "…" : `Kiste ${slot}`}
                  </span>
                  <span className="kisten-slot-meta">
                    {box
                      ? `${box.item_count} ${
                          de
                            ? box.item_count === 1
                              ? "Position"
                              : "Positionen"
                            : box.item_count === 1
                              ? "item"
                              : "items"
                        }`
                      : "—"}
                  </span>
                  {box?.customer_name && (
                    <span className="kisten-slot-customer">{box.customer_name}</span>
                  )}
                  <span
                    className={`kisten-status kisten-status--${box ? box.status : "offen"}`}
                  >
                    {statusLabel(box ? box.status : "offen")}
                  </span>
                </button>
              );
            })}
          </div>
        </article>

        {adHocBoxes.length > 0 && (
          <article className="werkstatt-card">
            <header className="werkstatt-card-head">
              <div className="werkstatt-card-title-block">
                <h3 className="werkstatt-card-title">{de ? "Sonderkisten" : "Ad-hoc boxes"}</h3>
                <span className="werkstatt-card-subtitle">
                  {de
                    ? "Für einzelne Aufträge angelegt — löschbar"
                    : "Created for a single job — deletable"}
                </span>
              </div>
            </header>
            <ul className="kisten-list">
              {adHocBoxes.map((box) => (
                <li key={box.id}>
                  <button
                    type="button"
                    className="kisten-row"
                    onClick={() => void openBox(box.id)}
                  >
                    <span className="kisten-row-main">
                      <span className="kisten-row-label">{box.label}</span>
                      <span className="kisten-row-meta">
                        {box.box_number}
                        {" · "}
                        {box.item_count}{" "}
                        {de
                          ? box.item_count === 1
                            ? "Position"
                            : "Positionen"
                          : box.item_count === 1
                            ? "item"
                            : "items"}
                        {box.customer_name ? ` · ${box.customer_name}` : ""}
                      </span>
                    </span>
                    <span className={`kisten-status kisten-status--${box.status}`}>
                      {statusLabel(box.status)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </article>
        )}
      </section>
    );
  }

  /* ── Detail view ───────────────────────────────────────────────────────── */

  return (
    <section className="werkstatt-tab-page kisten-page">
      {/* Kept out of the head block so the status pill lines up with the title
          rather than with the back link. */}
      <button
        type="button"
        className="werkstatt-card-action kisten-back"
        onClick={() => {
          setCameraOpen(false);
          setActiveBox(null);
          // Counts and statuses on the rack are stale after packing.
          void loadBoxes();
        }}
      >
        ← {de ? "Alle Kisten" : "All boxes"}
      </button>

      <header className="werkstatt-sub-head">
        <div className="werkstatt-sub-head-text">
          <h1 className="werkstatt-sub-title">
            {activeBox.label}
            {activeBox.slot !== null && (
              <span className="kisten-slot-badge">
                {de ? "Regalplatz" : "Slot"} {activeBox.slot}
              </span>
            )}
          </h1>
          <p className="werkstatt-sub-subtitle">
            {activeBox.box_number}
            {" · "}
            {activeBox.items.length}{" "}
            {de
              ? activeBox.items.length === 1
                ? "Position"
                : "Positionen"
              : activeBox.items.length === 1
                ? "item"
                : "items"}
            {activeBox.customer_name ? ` · ${activeBox.customer_name}` : ""}
          </p>
        </div>
        <div className="werkstatt-sub-actions">
          <span className={`kisten-status kisten-status--${activeBox.status}`}>
            {statusLabel(activeBox.status)}
          </span>
        </div>
      </header>

      <div className="werkstatt-content-grid">
        <div className="werkstatt-column">
          {!locked && (
            <article className="werkstatt-card">
              <header className="werkstatt-card-head">
                <div className="werkstatt-card-title-block">
                  <h3 className="werkstatt-card-title">
                    {de ? "Artikel hinzufügen" : "Add items"}
                  </h3>
                  <span className="werkstatt-card-subtitle">
                    {de
                      ? "Lager + Datanorm-Katalog · Bluetooth-Scanner funktioniert direkt"
                      : "Stock + Datanorm catalog · a Bluetooth scanner works directly"}
                  </span>
                </div>
              </header>
              <div className="kisten-card-body">
                <div className="kisten-search-row">
                  <div className="werkstatt-search kisten-search">
                    <SearchIcon />
                    <input
                      type="text"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder={de ? "Suchen oder scannen…" : "Search or scan…"}
                      autoFocus
                    />
                  </div>
                  {/* The decoder is only downloaded when this is tapped. */}
                  <button
                    type="button"
                    className="werkstatt-action-btn kisten-camera-btn"
                    onClick={() => setCameraOpen(true)}
                  >
                    <CameraIcon />
                    {de ? "Kamera" : "Camera"}
                  </button>
                </div>

                {hits.length > 0 && (
                  <ul className="kisten-hits">
                    {hits.map((hit, index) => (
                      <li
                        key={`${hit.source}-${hit.article_id ?? hit.catalog_external_key ?? index}`}
                      >
                        <button
                          type="button"
                          className="kisten-hit"
                          onClick={() =>
                            void addItem({
                              source: hit.source,
                              article_id: hit.article_id,
                              catalog_external_key: hit.catalog_external_key,
                              item_name: hit.item_name,
                              article_no: hit.article_no,
                              ean: hit.ean,
                              unit: hit.unit,
                              quantity: 1,
                            })
                          }
                        >
                          <span className="kisten-hit-main">
                            <span className="kisten-hit-name">{hit.item_name}</span>
                            <span className="kisten-hit-meta">
                              {hit.article_no ?? ""}
                              {hit.supplier_name && hit.supplier_article_no
                                ? `${hit.article_no ? " · " : ""}${hit.supplier_name} ${hit.supplier_article_no}`
                                : ""}
                            </span>
                          </span>
                          <span
                            className={`kisten-hit-stock${
                              hit.source === "article" ? "" : " kisten-hit-stock--catalog"
                            }`}
                          >
                            {hit.source === "article"
                              ? `${de ? "Lager" : "Stock"} ${hit.stock_available ?? 0}`
                              : de
                                ? "Katalog"
                                : "Catalog"}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                {search.trim() && hits.length === 0 && (
                  <button
                    type="button"
                    className="werkstatt-action-btn kisten-manual-add"
                    onClick={() =>
                      void addItem({ source: "manual", item_name: search.trim(), quantity: 1 })
                    }
                  >
                    +{" "}
                    {de
                      ? `"${search.trim()}" manuell hinzufügen`
                      : `Add "${search.trim()}" manually`}
                  </button>
                )}
              </div>
            </article>
          )}

          <article className="werkstatt-card">
            <header className="werkstatt-card-head">
              <div className="werkstatt-card-title-block">
                <h3 className="werkstatt-card-title">
                  {de ? "Inhalt" : "Contents"} ({activeBox.items.length})
                </h3>
                {locked && (
                  <span className="werkstatt-card-subtitle">
                    {de
                      ? "Übergeben — Inhalt gesperrt"
                      : "Handed over — contents locked"}
                  </span>
                )}
              </div>
              {!locked && activeBox.items.length > 0 && (
                <button
                  type="button"
                  className="werkstatt-card-action"
                  onClick={() => void clearBox()}
                >
                  {de ? "Kiste leeren" : "Empty box"}
                </button>
              )}
            </header>
            {activeBox.items.length === 0 ? (
              <div className="kisten-card-body">
                <p className="kisten-empty">{de ? "Kiste ist leer." : "Box is empty."}</p>
              </div>
            ) : (
              <ul className="kisten-items">
                {activeBox.items.map((item) => (
                  <li key={item.id} className="kisten-item">
                    <div className="kisten-item-main">
                      <span className="kisten-item-name">{item.item_name}</span>
                      <span className="kisten-item-meta">
                        {item.article_no ?? (de ? "ohne Artikelnummer" : "no article no.")}
                        {item.source === "catalog"
                          ? ` · ${de ? "Katalog" : "catalog"}`
                          : item.source === "manual"
                            ? ` · ${de ? "manuell" : "manual"}`
                            : ""}
                      </span>
                    </div>
                    {locked ? (
                      <span className="kisten-qty-static">
                        {item.quantity} {item.unit ?? ""}
                      </span>
                    ) : (
                      <div className="kisten-qty">
                        <button
                          type="button"
                          onClick={() => void changeQty(item, -1)}
                          aria-label={de ? "Menge verringern" : "Decrease quantity"}
                        >
                          −
                        </button>
                        <span className="kisten-qty-value">
                          {item.quantity}
                          {item.unit ? <small>{item.unit}</small> : null}
                        </span>
                        <button
                          type="button"
                          onClick={() => void changeQty(item, +1)}
                          aria-label={de ? "Menge erhöhen" : "Increase quantity"}
                        >
                          +
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </article>
        </div>

        <div className="werkstatt-column">
          <article className="werkstatt-card">
            <header className="werkstatt-card-head">
              <div className="werkstatt-card-title-block">
                <h3 className="werkstatt-card-title">
                  {locked ? (de ? "Übergabe" : "Handover") : de ? "Kiste zuweisen" : "Assign box"}
                </h3>
                <span className="werkstatt-card-subtitle">
                  {locked
                    ? de
                      ? "Der Bestand ist ausgebucht"
                      : "Stock is checked out"
                    : de
                      ? "Beim Zuweisen wird der Bestand ausgebucht"
                      : "Assigning checks the contents out of stock"}
                </span>
              </div>
            </header>
            <div className="kisten-card-body">
              {locked ? (
                <>
                  <p className="kisten-note">
                    {de ? "Beim Kunden" : "With the customer"}
                    {activeBox.customer_name ? `: ${activeBox.customer_name}` : ""}
                  </p>
                  <button
                    type="button"
                    className="werkstatt-action-btn werkstatt-action-btn--primary"
                    onClick={() => void setStatus("zurueck")}
                  >
                    {de ? "Kiste zurückbuchen" : "Return box"}
                  </button>
                </>
              ) : (
                <>
                  <CustomerCombobox
                    language={de ? "de" : "en"}
                    customers={customers}
                    value={{
                      customerId: assignCustomerId,
                      customerName: customers.find((c) => c.id === assignCustomerId)?.name ?? "",
                    }}
                    onChange={(next) => setAssignCustomerId(next.customerId)}
                    onRequestCreate={() => undefined}
                    placeholder={de ? "Kunde wählen…" : "Choose a customer…"}
                  />
                  <div className="kisten-action-row">
                    <button
                      type="button"
                      className="werkstatt-action-btn werkstatt-action-btn--primary"
                      onClick={() => void assign()}
                      disabled={assignCustomerId == null || activeBox.items.length === 0}
                    >
                      {de ? "Packen & zuweisen" : "Pack & assign"}
                    </button>
                    {activeBox.status === "zurueck" && (
                      <button
                        type="button"
                        className="werkstatt-action-btn"
                        onClick={() => void setStatus("offen")}
                      >
                        {de ? "Erneut öffnen" : "Re-open"}
                      </button>
                    )}
                  </div>
                  {activeBox.items.length === 0 && (
                    <p className="kisten-note kisten-note--muted">
                      {de
                        ? "Erst packen, dann zuweisen."
                        : "Pack the box before assigning it."}
                    </p>
                  )}
                </>
              )}
            </div>
          </article>

          {(activeBox.packed_at || activeBox.assigned_at || activeBox.returned_at) && (
            <article className="werkstatt-card">
              <header className="werkstatt-card-head">
                <div className="werkstatt-card-title-block">
                  <h3 className="werkstatt-card-title">{de ? "Verlauf" : "History"}</h3>
                </div>
              </header>
              <div className="kisten-card-body">
                <dl className="kisten-timeline">
                  {activeBox.packed_at && (
                    <>
                      <dt>{de ? "Gepackt" : "Packed"}</dt>
                      <dd>{formatServerDateTime(activeBox.packed_at, language)}</dd>
                    </>
                  )}
                  {activeBox.assigned_at && (
                    <>
                      <dt>{de ? "Übergeben" : "Handed over"}</dt>
                      <dd>{formatServerDateTime(activeBox.assigned_at, language)}</dd>
                    </>
                  )}
                  {activeBox.returned_at && (
                    <>
                      <dt>{de ? "Zurück" : "Returned"}</dt>
                      <dd>{formatServerDateTime(activeBox.returned_at, language)}</dd>
                    </>
                  )}
                </dl>
              </div>
            </article>
          )}
        </div>
      </div>

      <CameraScannerSheet
        open={cameraOpen && !locked}
        language={language}
        onClose={() => setCameraOpen(false)}
        onScan={runScan}
      />
    </section>
  );
}
