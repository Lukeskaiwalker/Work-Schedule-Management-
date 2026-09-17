import type { WerkstattCatalogGroup } from "../../types/werkstatt";

/**
 * KatalogPicker — pick one product out of the wholesalers' Datanorm.
 *
 * Rendering rules (per WERKSTATT_CONTRACT and Paper BIV-0):
 *   - hero card when several suppliers list the same EAN (shows the group)
 *   - compact card when only one supplier has it
 *   - amber footer callout when any row has no EAN (those cannot be scanned
 *     later and fall back to the internal SP-number)
 *
 * Two things changed when this stopped being a mock. It is typed against
 * `WerkstattCatalogGroup` — the shape `GET /werkstatt/catalog/search` and the
 * article lookup both return — instead of the empty `MockCatalogEntry`, so
 * what it renders is what the server said. And it does NOT filter: the
 * catalogue is millions of Datanorm rows deep, so client-side filtering would
 * only ever search the page that happened to be fetched. The host owns the
 * query and the request; this is a presenter.
 *
 * Selection is two-level on purpose. The GROUP decides what the article is
 * (name, EAN, manufacturer come from its hero row); the ticked supplier rows
 * decide which article numbers the new article carries, which is what every
 * later order resolves against.
 */
export interface KatalogPickerProps {
  groups: ReadonlyArray<WerkstattCatalogGroup>;
  /** The catalogue row id of the chosen group's hero, or null. */
  selectedCatalogItemId: number | null;
  /** Catalogue row ids whose suppliers will be linked to the new article. */
  selectedSupplierIds: ReadonlySet<number>;
  onToggleSupplier: (catalogItemId: number) => void;
  onSelectGroup: (group: WerkstattCatalogGroup) => void;
  language: "de" | "en";
  /** Inside a dialog the host already has a search field; skip ours. */
  embedded?: boolean;
  search?: { value: string; onChange: (value: string) => void };
  loading?: boolean;
}

export function KatalogPicker({
  groups,
  selectedCatalogItemId,
  selectedSupplierIds,
  onToggleSupplier,
  onSelectGroup,
  language,
  embedded = false,
  search,
  loading = false,
}: KatalogPickerProps) {
  const de = language === "de";
  const hasNoEan = groups.some((group) => !group.ean);

  return (
    <div className="werkstatt-katalog-picker">
      {!embedded && search && (
        <div className="werkstatt-search werkstatt-search--katalog">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="11" cy="11" r="6.3" stroke="#5C7895" strokeWidth="1.8" />
            <path d="m15.6 15.6 4 4" stroke="#5C7895" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            value={search.value}
            onChange={(event) => search.onChange(event.target.value)}
            placeholder={
              de
                ? "Name, EAN, Artikelnummer oder Hersteller suchen…"
                : "Search name, EAN, article number or manufacturer…"
            }
          />
        </div>
      )}

      <div className="werkstatt-katalog-head">
        <span>
          {loading
            ? de
              ? "Katalog wird durchsucht…"
              : "Searching the catalogue…"
            : de
              ? `${groups.length} Treffer`
              : `${groups.length} hits`}
        </span>
      </div>

      <ul className="werkstatt-katalog-list">
        {groups.map((group) => {
          const isMulti = group.suppliers.length > 1;
          const isSelected = selectedCatalogItemId === group.hero.id;
          return (
            <li
              key={group.ean ?? `row-${group.hero.id}`}
              className={`werkstatt-katalog-card${isMulti ? " werkstatt-katalog-card--hero" : ""}${isSelected ? " werkstatt-katalog-card--selected" : ""}`}
            >
              <button
                type="button"
                className="werkstatt-katalog-card-head"
                onClick={() => onSelectGroup(group)}
              >
                <span className="werkstatt-katalog-thumb" aria-hidden="true">
                  {group.hero.image_url ? (
                    <img src={group.hero.image_url} alt="" />
                  ) : (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Z"
                        stroke="#5C7895"
                        strokeWidth="1.6"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </span>
                <span className="werkstatt-katalog-title">
                  <b>{group.hero.item_name}</b>
                  <span
                    className={`werkstatt-katalog-supplier-tag${isMulti ? "" : " werkstatt-katalog-supplier-tag--single"}`}
                  >
                    {group.suppliers.length}{" "}
                    {isMulti
                      ? de
                        ? "Lieferanten"
                        : "suppliers"
                      : de
                        ? "Lieferant"
                        : "supplier"}
                  </span>
                  <small className="werkstatt-katalog-meta">
                    {group.hero.manufacturer ?? "—"} ·{" "}
                    {group.ean ? `EAN ${group.ean}` : de ? "keine EAN" : "no EAN"}
                  </small>
                </span>
                {!isMulti && (
                  <span className="werkstatt-katalog-hero-price">
                    <b>{group.hero.price_text || "—"}</b>
                    <small>{group.hero.article_no || "—"}</small>
                  </span>
                )}
                <span
                  className={`werkstatt-katalog-check${isSelected ? " werkstatt-katalog-check--on" : ""}`}
                  aria-hidden="true"
                >
                  {isSelected ? "✓" : ""}
                </span>
              </button>

              {isMulti && (
                <ul className="werkstatt-katalog-offers">
                  {group.suppliers.map((row) => {
                    const ticked = selectedSupplierIds.has(row.id);
                    return (
                      <li key={row.id} className="werkstatt-katalog-offer">
                        <button
                          type="button"
                          className={`werkstatt-katalog-offer-check${ticked ? " werkstatt-katalog-offer-check--on" : ""}`}
                          aria-pressed={ticked}
                          aria-label={row.supplier_name ?? (de ? "Lieferant" : "Supplier")}
                          onClick={() => onToggleSupplier(row.id)}
                        >
                          {ticked ? "✓" : ""}
                        </button>
                        <span className="werkstatt-katalog-offer-main">
                          <b>{row.supplier_name ?? (de ? "ohne Lieferant" : "no supplier")}</b>
                          <small>Art.-Nr. {row.article_no || "—"}</small>
                        </span>
                        <span className="werkstatt-katalog-offer-price">
                          {row.price_text || "—"}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
        {groups.length === 0 && !loading && (
          <li className="werkstatt-katalog-empty muted">
            {de ? "Keine Katalogeinträge gefunden." : "No catalog entries found."}
          </li>
        )}
      </ul>

      {hasNoEan && (
        <div className="werkstatt-no-ean-warn" role="note">
          <span className="werkstatt-no-ean-warn-icon" aria-hidden="true">
            ⚠
          </span>
          <span>
            {de
              ? "Keine EAN — kann später nicht per Scan gefunden werden. System verwendet die interne SP-Nummer."
              : "No EAN — cannot be found by scan later. The system will use the internal SP number."}
          </span>
        </div>
      )}
    </div>
  );
}
