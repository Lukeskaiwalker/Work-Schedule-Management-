import { useEffect, useMemo, useRef, useState } from "react";
import { useAppContext } from "../../context/AppContext";
import { NeuerArtikelModal } from "../../components/werkstatt/NeuerArtikelModal";
import {
  MOCK_CATALOG_ENTRIES,
  MOCK_SUPPLIERS,
  type MockCatalogEntry,
} from "../../components/werkstatt/mockData";
import type { MaterialCatalogItem } from "../../types";

/**
 * WerkstattKatalogPage — Datanorm catalog browse / search. Relocated from
 * MaterialsPage and extended with the multi-supplier grouping pattern from
 * Paper BIV-0.
 *
 * Input-binding strategy: the live `materialCatalogQuery` from AppContext
 * drives the search — the same state the legacy MaterialsPage used — so
 * deep links and server-side search keep working. We then group results by
 * EAN to render hero cards when multiple suppliers share the same EAN.
 *
 * When no EAN is present the row renders as a compact card; an amber warning
 * explains that scan-match will fall back to the internal SP-number.
 *
 * TODO(werkstatt): wire to /api/werkstatt/catalog/search once the BE lands.
 * For now the page falls back to MOCK_CATALOG_ENTRIES when the real catalog
 * rows haven't been requested yet so the hero-card layout is visible.
 */
export function WerkstattKatalogPage() {
  const {
    mainView,
    language,
    werkstattTab,
    materialCatalogRows,
    materialCatalogQuery,
    setMaterialCatalogQuery,
    materialCatalogLoading,
    loadMaterialCatalog,
    uploadMaterialCatalogImage,
    deleteMaterialCatalogImage,
    setNotice,
  } = useAppContext();

  const [activeSupplier, setActiveSupplier] = useState<string | null>(null);
  const [neuerArtikelOpen, setNeuerArtikelOpen] = useState(false);
  const [neuerArtikelSeed, setNeuerArtikelSeed] = useState<MockCatalogEntry | null>(null);
  const [imageUploadingKeys, setImageUploadingKeys] = useState<Set<string>>(new Set());
  const imageFileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // Map each folded MockCatalogEntry back to its source MaterialCatalogItem so
  // we can render thumbnails + per-row upload controls without extending the
  // fake-first MockCatalogEntry shape.
  const rowsByEntryId = useMemo(() => {
    const map = new Map<string, MaterialCatalogItem>();
    for (const row of materialCatalogRows) {
      if (row.ean) {
        const key = `ean-${row.ean}`;
        // Prefer the row that already has an image — that's the one users
        // care about when there are multiple supplier listings per EAN.
        if (!map.has(key) || (!map.get(key)?.image_url && row.image_url)) {
          map.set(key, row);
        }
      } else {
        map.set(`row-entry-${row.id}`, row);
      }
    }
    return map;
  }, [materialCatalogRows]);

  async function handleCatalogImageUpload(externalKey: string, file: File) {
    setImageUploadingKeys((current) => {
      const next = new Set(current);
      next.add(externalKey);
      return next;
    });
    try {
      await uploadMaterialCatalogImage(externalKey, file);
    } finally {
      setImageUploadingKeys((current) => {
        const next = new Set(current);
        next.delete(externalKey);
        return next;
      });
    }
  }

  // Kick a search on first mount so the panel isn't empty.
  useEffect(() => {
    if (mainView !== "werkstatt" || werkstattTab !== "katalog") return;
    if (materialCatalogRows.length > 0 || materialCatalogLoading) return;
    void loadMaterialCatalog(materialCatalogQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainView, werkstattTab]);

  // Prefer server rows when present; fall back to mocks so the layout shows
  // while the BE is still being built (replacement blocked on §3.3 endpoint).
  const sourceEntries = useMemo<ReadonlyArray<MockCatalogEntry>>(() => {
    if (materialCatalogRows.length === 0) return MOCK_CATALOG_ENTRIES;
    // Fold the flat MaterialCatalogItem rows into the MockCatalogEntry shape
    // so the hero-card grouping works identically for both sources.
    const byEan = new Map<string, MockCatalogEntry>();
    const singles: MockCatalogEntry[] = [];
    for (const row of materialCatalogRows) {
      const offerId = `row-${row.id}`;
      const offer = {
        id: offerId,
        supplier_name: row.manufacturer?.trim() || "—",
        supplier_article_no: row.article_no?.trim() ?? "",
        lead_time_days: 0,
        price_text: row.price_text?.trim() ?? "",
        is_preferred: false,
      };
      if (!row.ean) {
        singles.push({
          id: `row-entry-${row.id}`,
          item_name: row.item_name,
          manufacturer: row.manufacturer ?? null,
          ean: null,
          offers: [offer],
        });
        continue;
      }
      const existing = byEan.get(row.ean);
      if (existing) {
        byEan.set(row.ean, {
          ...existing,
          offers: [...existing.offers, offer],
        });
      } else {
        byEan.set(row.ean, {
          id: `ean-${row.ean}`,
          item_name: row.item_name,
          manufacturer: row.manufacturer ?? null,
          ean: row.ean,
          offers: [offer],
        });
      }
    }
    return [...byEan.values(), ...singles];
  }, [materialCatalogRows]);

  const supplierChips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of sourceEntries) {
      for (const offer of entry.offers) {
        counts.set(offer.supplier_name, (counts.get(offer.supplier_name) ?? 0) + 1);
      }
    }
    return MOCK_SUPPLIERS.map((s) => ({
      id: s.id,
      name: s.name,
      count: counts.get(s.name) ?? 0,
    })).filter((c) => c.count > 0);
  }, [sourceEntries]);

  const visibleEntries = useMemo(() => {
    if (!activeSupplier) return sourceEntries;
    return sourceEntries.filter((entry) =>
      entry.offers.some((offer) => offer.supplier_name === activeSupplier),
    );
  }, [sourceEntries, activeSupplier]);

  if (mainView !== "werkstatt" || werkstattTab !== "katalog") return null;

  const de = language === "de";
  const hasNoEan = visibleEntries.some((entry) => !entry.ean);
  const totalOffers = visibleEntries.reduce((sum, e) => sum + e.offers.length, 0);

  return (
    <section className="werkstatt-tab-page">
      <header className="werkstatt-sub-head">
        <div className="werkstatt-sub-head-text">
          <span className="werkstatt-sub-breadcrumb">
            {de ? "WERKSTATT › KATALOG" : "WORKSHOP › CATALOG"}
          </span>
          <h1 className="werkstatt-sub-title">
            {de ? "Datanorm-Katalog" : "Datanorm catalog"}
          </h1>
          <p className="werkstatt-sub-subtitle">
            {de
              ? "Durchsuche den Datanorm-Pool aller Lieferanten. Gleiche Produkte (gleiche EAN) werden automatisch zusammengefasst."
              : "Browse the Datanorm pool across all suppliers. Identical products (same EAN) are grouped automatically."}
          </p>
        </div>
      </header>

      <div className="werkstatt-filter-bar werkstatt-filter-bar--slim">
        <div className="werkstatt-search werkstatt-search--katalog">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="11" cy="11" r="6.3" stroke="#5C7895" strokeWidth="1.8" />
            <path d="m15.6 15.6 4 4" stroke="#5C7895" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            value={materialCatalogQuery}
            onChange={(event) => setMaterialCatalogQuery(event.target.value)}
            placeholder={
              de
                ? "Name, EAN, Artikelnummer oder Hersteller suchen…"
                : "Search name, EAN, article number or manufacturer…"
            }
          />
        </div>
      </div>

      <div className="werkstatt-card werkstatt-katalog-wrap">
        <div className="werkstatt-chips" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeSupplier === null}
            className={`werkstatt-chip${activeSupplier === null ? " werkstatt-chip--active" : ""}`}
            onClick={() => setActiveSupplier(null)}
          >
            {de ? "Alle" : "All"}
            <span className="werkstatt-chip-count">
              {sourceEntries.reduce((sum, e) => sum + e.offers.length, 0)}
            </span>
          </button>
          {supplierChips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              role="tab"
              aria-selected={activeSupplier === chip.name}
              className={`werkstatt-chip${activeSupplier === chip.name ? " werkstatt-chip--active" : ""}`}
              onClick={() => setActiveSupplier(chip.name)}
            >
              {chip.name}
              <span className="werkstatt-chip-count">{chip.count}</span>
            </button>
          ))}
        </div>

        <div className="werkstatt-katalog-head">
          <span>
            {de
              ? `${visibleEntries.length} Produkte · ${totalOffers} Angebote`
              : `${visibleEntries.length} products · ${totalOffers} offers`}
          </span>
          {materialCatalogLoading && (
            <span className="muted">{de ? "Lädt…" : "Loading…"}</span>
          )}
        </div>

        <ul className="werkstatt-katalog-list">
          {visibleEntries.map((entry) => {
            const isMulti = entry.offers.length > 1;
            const preferred = entry.offers.find((o) => o.is_preferred) ?? entry.offers[0];
            const sourceRow = rowsByEntryId.get(entry.id) ?? null;
            const externalKey = sourceRow?.external_key ?? "";
            const imageUrl = sourceRow?.image_url ?? null;
            const isManualImage = sourceRow?.image_source === "manual";
            const isImageUploading = externalKey
              ? imageUploadingKeys.has(externalKey)
              : false;
            return (
              <li
                key={entry.id}
                className={`werkstatt-katalog-card${isMulti ? " werkstatt-katalog-card--hero" : ""}`}
              >
                <div className="werkstatt-katalog-card-head">
                  <span
                    className="werkstatt-katalog-thumb"
                    style={{ position: "relative", overflow: "hidden" }}
                    title={
                      externalKey
                        ? imageUrl
                          ? isManualImage
                            ? de
                              ? "Manuell hochgeladen. Klicken zum Ersetzen."
                              : "Manually uploaded. Click to replace."
                            : de
                              ? "Automatisch gefunden. Klicken zum Ersetzen."
                              : "Auto-fetched. Click to replace."
                          : de
                            ? "Kein Bild — klicken zum Hochladen."
                            : "No image — click to upload."
                        : undefined
                    }
                  >
                    {imageUrl ? (
                      <img
                        src={imageUrl}
                        alt=""
                        style={{ width: "100%", height: "100%", objectFit: "contain" }}
                      />
                    ) : (
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path
                          d="M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Z"
                          stroke="#5C7895"
                          strokeWidth="1.6"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                    {externalKey && (
                      <>
                        <button
                          type="button"
                          onClick={() => imageFileInputRefs.current[externalKey]?.click()}
                          disabled={isImageUploading}
                          aria-label={
                            imageUrl
                              ? de ? "Bild ersetzen" : "Replace image"
                              : de ? "Bild hochladen" : "Upload image"
                          }
                          style={{
                            position: "absolute",
                            inset: 0,
                            background: "transparent",
                            border: "none",
                            cursor: "pointer",
                            padding: 0,
                          }}
                        />
                        {isManualImage && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              void deleteMaterialCatalogImage(externalKey);
                            }}
                            aria-label={de ? "Bild entfernen" : "Remove image"}
                            title={de ? "Bild entfernen" : "Remove image"}
                            style={{
                              position: "absolute",
                              top: 2,
                              right: 2,
                              width: 14,
                              height: 14,
                              padding: 0,
                              borderRadius: 7,
                              border: "none",
                              background: "rgba(20, 41, 61, 0.72)",
                              color: "#ffffff",
                              fontSize: 9,
                              lineHeight: "12px",
                              cursor: "pointer",
                            }}
                          >
                            ×
                          </button>
                        )}
                        {isImageUploading && (
                          <span
                            style={{
                              position: "absolute",
                              inset: 0,
                              background: "rgba(255,255,255,0.6)",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              fontSize: 11,
                              color: "#14293d",
                            }}
                          >
                            …
                          </span>
                        )}
                        <input
                          ref={(node) => {
                            imageFileInputRefs.current[externalKey] = node;
                          }}
                          type="file"
                          accept="image/jpeg,image/png,image/webp,image/gif"
                          hidden
                          onChange={(event) => {
                            const picked = event.target.files?.[0];
                            event.target.value = "";
                            if (picked) void handleCatalogImageUpload(externalKey, picked);
                          }}
                        />
                      </>
                    )}
                  </span>
                  <span className="werkstatt-katalog-title">
                    <b>{entry.item_name}</b>
                    <span
                      className={`werkstatt-katalog-supplier-tag${isMulti ? "" : " werkstatt-katalog-supplier-tag--single"}`}
                    >
                      {entry.offers.length}{" "}
                      {isMulti
                        ? de
                          ? "Lieferanten"
                          : "suppliers"
                        : de
                          ? "Lieferant"
                          : "supplier"}
                    </span>
                    <small className="werkstatt-katalog-meta">
                      {entry.manufacturer ?? "—"} ·{" "}
                      {entry.ean ? `EAN ${entry.ean}` : de ? "keine EAN" : "no EAN"}
                    </small>
                  </span>
                  {!isMulti && (
                    <span className="werkstatt-katalog-hero-price">
                      <b>{preferred.price_text || "—"}</b>
                      <small>
                        {de
                          ? `${preferred.lead_time_days} Werktage`
                          : `${preferred.lead_time_days} days`}
                      </small>
                    </span>
                  )}
                  <button
                    type="button"
                    className="werkstatt-action-btn werkstatt-action-btn--primary"
                    onClick={() => {
                      setNeuerArtikelSeed(entry);
                      setNeuerArtikelOpen(true);
                    }}
                  >
                    {de ? "In Werkstatt anlegen" : "Add to workshop"}
                  </button>
                </div>
                {isMulti && (
                  <ul className="werkstatt-katalog-offers">
                    {entry.offers.map((offer) => (
                      <li key={offer.id} className="werkstatt-katalog-offer">
                        <span className="werkstatt-katalog-offer-main">
                          <b>
                            {offer.supplier_name}
                            {offer.is_preferred && (
                              <span className="werkstatt-katalog-preferred">
                                {de ? "PREFERRED" : "PREFERRED"}
                              </span>
                            )}
                          </b>
                          <small>Art.-Nr. {offer.supplier_article_no || "—"}</small>
                        </span>
                        <span className="werkstatt-katalog-offer-lead">
                          {de
                            ? `${offer.lead_time_days} Werktage`
                            : `${offer.lead_time_days} days`}
                        </span>
                        <span className="werkstatt-katalog-offer-price">
                          {offer.price_text || "—"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
          {visibleEntries.length === 0 && (
            <li className="werkstatt-katalog-empty muted">
              {de ? "Keine Katalogeinträge gefunden." : "No catalog entries found."}
            </li>
          )}
        </ul>

        {hasNoEan && (
          <div className="werkstatt-no-ean-warn" role="note">
            <span className="werkstatt-no-ean-warn-icon" aria-hidden="true">⚠</span>
            <span>
              {de
                ? "Einige Produkte haben keine EAN — sie können später nicht per Scan gefunden werden und laufen über die interne SP-Nummer."
                : "Some products have no EAN — they cannot be found by scan and will fall back to the internal SP number."}
            </span>
          </div>
        )}
      </div>

      <NeuerArtikelModal
        open={neuerArtikelOpen}
        onClose={() => setNeuerArtikelOpen(false)}
        language={language}
        onSave={(payload) => {
          setNeuerArtikelOpen(false);
          const seedName = neuerArtikelSeed?.item_name ?? payload.item_name;
          setNotice(
            de
              ? `Artikel "${seedName}" mit Lieferanten verknüpft (API folgt)`
              : `Article "${seedName}" linked to suppliers (API pending)`,
          );
          // TODO(werkstatt): POST /api/werkstatt/articles/from-catalog with
          //   { catalog_item_id: neuerArtikelSeed.catalog_item_id, supplier_links[] }
        }}
      />
    </section>
  );
}
