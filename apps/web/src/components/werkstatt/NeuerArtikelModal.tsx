import { useState } from "react";
import { KatalogPicker } from "./KatalogPicker";
import { NeuerArtikelManualTab } from "./NeuerArtikelManualTab";
import { useBarcodeScanner } from "../../hooks/useBarcodeScanner";
import {
  MOCK_CATALOG_ENTRIES,
  MOCK_SUPPLIERS,
} from "./mockData";

/**
 * NeuerArtikelModal — "Artikel anlegen" dialog. Ported from Paper 9ZD-0.
 *
 * Three entry tabs:
 *   - Manuell — direct form (name, EAN, category, location, counts)
 *   - Aus Katalog — embeds <KatalogPicker /> for a multi-supplier pick
 *   - QR-Scan — a code slab + auto-resolve when a scan lands
 *
 * The primary action label swaps based on the active tab:
 *   - Manuell / QR   → "Artikel speichern"
 *   - Aus Katalog    → "Artikel anlegen + verknüpfen"
 *
 * Pure presenter. Caller controls visibility and wires the save payload —
 * TODO(werkstatt): dispatch to /api/werkstatt/articles once BE endpoints land.
 */
type EntryTab = "manual" | "catalog" | "scan";

export interface NeuerArtikelModalProps {
  open: boolean;
  onClose: () => void;
  language: "de" | "en";
  /** Called on primary CTA click with the current form snapshot. */
  onSave: (payload: {
    tab: EntryTab;
    item_name: string;
    article_number: string;
    ean: string | null;
    manufacturer: string | null;
    category_name: string | null;
    location_name: string | null;
    stock_total: number;
    stock_min: number;
    purchase_price_cents: number | null;
    catalog_entry_id: string | null;
    linked_supplier_ids: string[];
  }) => void;
}

export function NeuerArtikelModal({
  open,
  onClose,
  language,
  onSave,
}: NeuerArtikelModalProps) {
  const [tab, setTab] = useState<EntryTab>("manual");

  // Manual form state
  const [itemName, setItemName] = useState("Hilti TE 30 Bohrhammer SDS-plus");
  const [articleNumber, setArticleNumber] = useState("SP-0201");
  const [ean, setEan] = useState("");
  const [manufacturer] = useState("Hilti");
  const [categoryName, setCategoryName] = useState("Elektrowerkzeug · Bohrhammer");
  const [locationName, setLocationName] = useState("Halle 1 · Werkzeugwand");
  const [stockTotal, setStockTotal] = useState(4);
  const [stockMin, setStockMin] = useState(2);
  const [priceEur, setPriceEur] = useState("1248,00");
  // MOCK_SUPPLIERS is intentionally empty since v2.0.0 — fall back to "" so
  // the modal mounts cleanly. Real supplier pick is driven by the parent
  // once the Werkstatt BE endpoints land.
  const [supplierId, setSupplierId] = useState<string>(MOCK_SUPPLIERS[0]?.id ?? "");
  const [supplierArticleNo, setSupplierArticleNo] = useState("26190");
  const [bgRequired, setBgRequired] = useState(true);

  // Catalog picker state
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [selectedOffers, setSelectedOffers] = useState<ReadonlySet<string>>(new Set());

  // Scan tab state
  const [lastScannedCode, setLastScannedCode] = useState<string | null>(null);

  // TODO(werkstatt): replace with real /api/werkstatt/scan/resolve call.
  useBarcodeScanner({
    enabled: open && tab === "scan",
    onScan: (code) => {
      setLastScannedCode(code);
    },
  });

  if (!open) return null;

  const de = language === "de";
  const primaryLabel =
    tab === "catalog"
      ? de
        ? "Artikel anlegen + verknüpfen"
        : "Create + link article"
      : de
        ? "Artikel speichern"
        : "Save article";

  function handleToggleOffer(_entryId: string, offerId: string) {
    setSelectedOffers((prev) => {
      const next = new Set(prev);
      if (next.has(offerId)) next.delete(offerId);
      else next.add(offerId);
      return next;
    });
  }

  function handleSave() {
    const linkedSuppliers = tab === "catalog" ? Array.from(selectedOffers) : [supplierId];
    const parsedPrice = Number.parseFloat(priceEur.replace(/\./g, "").replace(",", "."));
    const priceCents = Number.isFinite(parsedPrice) ? Math.round(parsedPrice * 100) : null;
    onSave({
      tab,
      item_name: itemName,
      article_number: articleNumber,
      ean: ean.trim() ? ean.trim() : null,
      manufacturer: manufacturer.trim() ? manufacturer.trim() : null,
      category_name: categoryName || null,
      location_name: locationName || null,
      stock_total: stockTotal,
      stock_min: stockMin,
      purchase_price_cents: priceCents,
      catalog_entry_id: selectedEntryId,
      linked_supplier_ids: linkedSuppliers,
    });
  }

  const catalogFooterNote =
    tab === "catalog" && selectedEntryId !== null
      ? `1 ${de ? "Artikel ausgewählt" : "article selected"} · ${selectedOffers.size} ${de ? "Lieferanten verknüpft" : "suppliers linked"}`
      : null;

  // Suppress unused-variable noise while backend wires up.
  void supplierArticleNo;
  void setSupplierArticleNo;

  return (
    <div className="werkstatt-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="werkstatt-modal werkstatt-modal--wide"
        role="dialog"
        aria-modal="true"
        aria-label={de ? "Artikel anlegen" : "Create article"}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="werkstatt-modal-head">
          <div>
            <span className="werkstatt-sub-breadcrumb">
              {de ? "WERKSTATT · NEUER ARTIKEL" : "WORKSHOP · NEW ARTICLE"}
            </span>
            <h2 className="werkstatt-modal-title">
              {tab === "catalog"
                ? de
                  ? "Artikel aus Katalog wählen"
                  : "Choose article from catalog"
                : de
                  ? "Artikel anlegen"
                  : "Create article"}
            </h2>
          </div>
          <button
            type="button"
            className="werkstatt-modal-close"
            onClick={onClose}
            aria-label={de ? "Schließen" : "Close"}
          >
            ✕
          </button>
        </header>

        <div className="werkstatt-modal-tabs" role="tablist">
          <TabButton active={tab === "manual"} onClick={() => setTab("manual")}>
            {de ? "Manuell" : "Manual"}
          </TabButton>
          <TabButton active={tab === "catalog"} onClick={() => setTab("catalog")}>
            {de ? "Aus Katalog" : "From catalog"}
          </TabButton>
          <TabButton active={tab === "scan"} onClick={() => setTab("scan")}>
            {de ? "QR-Scan" : "QR scan"}
          </TabButton>
        </div>

        <div className="werkstatt-modal-body">
          {tab === "manual" && (
            <NeuerArtikelManualTab
              de={de}
              itemName={itemName}
              setItemName={setItemName}
              articleNumber={articleNumber}
              setArticleNumber={setArticleNumber}
              ean={ean}
              setEan={setEan}
              categoryName={categoryName}
              setCategoryName={setCategoryName}
              locationName={locationName}
              setLocationName={setLocationName}
              stockTotal={stockTotal}
              setStockTotal={setStockTotal}
              stockMin={stockMin}
              setStockMin={setStockMin}
              priceEur={priceEur}
              setPriceEur={setPriceEur}
              supplierId={supplierId}
              setSupplierId={setSupplierId}
              bgRequired={bgRequired}
              setBgRequired={setBgRequired}
            />
          )}
          {tab === "catalog" && (
            <KatalogPicker
              entries={MOCK_CATALOG_ENTRIES}
              selectedEntryId={selectedEntryId}
              selectedOfferIds={selectedOffers}
              onToggleOffer={handleToggleOffer}
              onSelectEntry={(entryId) => {
                setSelectedEntryId(entryId);
                // Auto-select the preferred offer (if any) on first pick.
                const entry = MOCK_CATALOG_ENTRIES.find((e) => e.id === entryId);
                if (entry) {
                  const preferred = entry.offers.find((o) => o.is_preferred);
                  if (preferred) setSelectedOffers(new Set([preferred.id]));
                }
              }}
              language={language}
              embedded={false}
              supplierChips={MOCK_SUPPLIERS.map((s) => ({
                id: s.id,
                name: s.name,
                count: s.article_count,
              }))}
            />
          )}
          {tab === "scan" && (
            <ScanTab de={de} lastCode={lastScannedCode} />
          )}
        </div>

        <footer className="werkstatt-modal-foot">
          <small className="muted">{catalogFooterNote ?? ""}</small>
          <div className="werkstatt-modal-foot-actions">
            {tab === "manual" && (
              <button type="button" className="werkstatt-action-btn">
                <span aria-hidden="true">▥</span> {de ? "QR-Etikett drucken" : "Print QR label"}
              </button>
            )}
            <button type="button" className="werkstatt-action-btn" onClick={onClose}>
              {de ? "Abbrechen" : "Cancel"}
            </button>
            <button
              type="button"
              className="werkstatt-action-btn werkstatt-action-btn--primary"
              onClick={handleSave}
              disabled={tab === "catalog" && selectedEntryId === null}
            >
              {primaryLabel}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`werkstatt-modal-tab${active ? " werkstatt-modal-tab--active" : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ScanTab({ de, lastCode }: { de: boolean; lastCode: string | null }) {
  return (
    <div className="werkstatt-scan-tab">
      <div className="werkstatt-scan-slab">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="3.5" y="3.5" width="17" height="17" rx="2" stroke="#2F70B7" strokeWidth="1.8" />
          <path d="M8 3.5v17M16 3.5v17M3.5 8h17M3.5 16h17" stroke="#2F70B7" strokeWidth="1.8" />
        </svg>
        <b>
          {de
            ? "Scanner bereit — halte den Artikel vor das Lesegerät."
            : "Scanner ready — point the item at the reader."}
        </b>
        <small>
          {de
            ? "EAN, SP-Nummer oder Lieferanten-Nr. werden erkannt."
            : "EAN, SP number or supplier number are detected."}
        </small>
      </div>
      {lastCode && (
        <div className="werkstatt-scan-result">
          <span className="werkstatt-scan-result-label">
            {de ? "Letzter Scan" : "Last scan"}
          </span>
          <code>{lastCode}</code>
          <span className="muted">
            {de
              ? "Auflösung steht aus — BE Endpoint fehlt noch"
              : "Resolution pending — BE endpoint not yet wired"}
          </span>
        </div>
      )}
    </div>
  );
}
