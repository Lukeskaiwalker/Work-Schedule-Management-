import { MOCK_SUPPLIERS } from "./mockData";

/**
 * NeuerArtikelManualTab — the "Manuell" tab body of NeuerArtikelModal.
 * Extracted to keep the parent modal under the <400 line cap. Pure form —
 * all state lives in the parent and is threaded through props.
 */
export interface NeuerArtikelManualTabProps {
  de: boolean;
  itemName: string;
  setItemName: (value: string) => void;
  articleNumber: string;
  setArticleNumber: (value: string) => void;
  ean: string;
  setEan: (value: string) => void;
  categoryName: string;
  setCategoryName: (value: string) => void;
  locationName: string;
  setLocationName: (value: string) => void;
  stockTotal: number;
  setStockTotal: (value: number) => void;
  stockMin: number;
  setStockMin: (value: number) => void;
  priceEur: string;
  setPriceEur: (value: string) => void;
  supplierId: string;
  setSupplierId: (value: string) => void;
  bgRequired: boolean;
  setBgRequired: (value: boolean) => void;
}

export function NeuerArtikelManualTab(props: NeuerArtikelManualTabProps) {
  const { de } = props;
  return (
    <div className="werkstatt-modal-form">
      <div className="werkstatt-modal-form-split">
        <div className="werkstatt-photo-drop" role="button" tabIndex={0}>
          <span className="werkstatt-photo-drop-icon" aria-hidden="true">+</span>
          <b>{de ? "Foto hinzufügen" : "Add photo"}</b>
          <small>PNG / JPG · max 8 MB</small>
        </div>
        <div className="werkstatt-modal-form-column">
          <label className="werkstatt-field">
            <span className="werkstatt-field-label">
              {de ? "Bezeichnung" : "Item name"}
              <span className="werkstatt-required">*</span>
            </span>
            <input
              type="text"
              className="werkstatt-field-input"
              value={props.itemName}
              onChange={(event) => props.setItemName(event.target.value)}
            />
          </label>
          <div className="werkstatt-field-row">
            <label className="werkstatt-field werkstatt-field--grow">
              <span className="werkstatt-field-label">
                {de ? "Artikelnummer" : "Article number"}
              </span>
              <div className="werkstatt-field-input-wrap">
                <input
                  type="text"
                  className="werkstatt-field-input"
                  value={props.articleNumber}
                  onChange={(event) => props.setArticleNumber(event.target.value)}
                />
                <span className="werkstatt-field-suffix">auto</span>
              </div>
            </label>
            <label className="werkstatt-field werkstatt-field--grow">
              <span className="werkstatt-field-label">
                {de ? "Seriennummer" : "Serial number"}
              </span>
              <input
                type="text"
                className="werkstatt-field-input"
                value={props.ean}
                onChange={(event) => props.setEan(event.target.value)}
                placeholder="H-88451"
              />
            </label>
          </div>
        </div>
      </div>

      <div className="werkstatt-field-row">
        <label className="werkstatt-field werkstatt-field--grow">
          <span className="werkstatt-field-label">{de ? "Kategorie" : "Category"}</span>
          <div className="werkstatt-field-input-wrap">
            <span className="werkstatt-field-prefix werkstatt-field-prefix--dot" aria-hidden="true" />
            <input
              type="text"
              className="werkstatt-field-input"
              value={props.categoryName}
              onChange={(event) => props.setCategoryName(event.target.value)}
            />
          </div>
        </label>
        <label className="werkstatt-field werkstatt-field--grow">
          <span className="werkstatt-field-label">{de ? "Lagerort" : "Location"}</span>
          <input
            type="text"
            className="werkstatt-field-input"
            value={props.locationName}
            onChange={(event) => props.setLocationName(event.target.value)}
          />
        </label>
      </div>

      <div className="werkstatt-field-row">
        <label className="werkstatt-field werkstatt-field--grow">
          <span className="werkstatt-field-label">{de ? "Startbestand" : "Starting stock"}</span>
          <div className="werkstatt-field-input-wrap">
            <input
              type="number"
              min={0}
              className="werkstatt-field-input"
              value={props.stockTotal}
              onChange={(event) => props.setStockTotal(Number(event.target.value))}
            />
            <span className="werkstatt-field-suffix">{de ? "Stück" : "pcs"}</span>
          </div>
        </label>
        <label className="werkstatt-field werkstatt-field--grow">
          <span className="werkstatt-field-label">
            {de ? "Mindestbestand" : "Minimum stock"}
          </span>
          <div className="werkstatt-field-input-wrap">
            <input
              type="number"
              min={0}
              className="werkstatt-field-input"
              value={props.stockMin}
              onChange={(event) => props.setStockMin(Number(event.target.value))}
            />
            <span className="werkstatt-field-suffix">
              {de ? "alert unter" : "alert below"}
            </span>
          </div>
        </label>
        <label className="werkstatt-field werkstatt-field--grow">
          <span className="werkstatt-field-label">{de ? "Einkaufspreis" : "Purchase price"}</span>
          <div className="werkstatt-field-input-wrap">
            <input
              type="text"
              className="werkstatt-field-input"
              value={props.priceEur}
              onChange={(event) => props.setPriceEur(event.target.value)}
            />
            <span className="werkstatt-field-suffix">€ {de ? "netto" : "net"}</span>
          </div>
        </label>
      </div>

      <label className="werkstatt-field">
        <span className="werkstatt-field-label">
          {de ? "Lieferant (optional)" : "Supplier (optional)"}
        </span>
        <select
          className="werkstatt-field-select"
          value={props.supplierId}
          onChange={(event) => props.setSupplierId(event.target.value)}
        >
          {MOCK_SUPPLIERS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>

      <div className="werkstatt-bg-toggle">
        <span className="werkstatt-bg-icon" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6l-7-3Z"
              stroke="#2F70B7"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="werkstatt-bg-main">
          <b>{de ? "BG-Prüfpflichtig" : "Safety check required"}</b>
          <small>
            {de
              ? "Prüfintervall + nächstes Fälligkeitsdatum konfigurieren"
              : "Configure inspection interval + next due date"}
          </small>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={props.bgRequired}
          className={`werkstatt-switch${props.bgRequired ? " werkstatt-switch--on" : ""}`}
          onClick={() => props.setBgRequired(!props.bgRequired)}
        >
          <span className="werkstatt-switch-thumb" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
