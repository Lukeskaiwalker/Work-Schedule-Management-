/**
 * The article form itself — one set of fields, used by create AND edit.
 *
 * The old "Manuell" tab asked for a Seriennummer (a machine's field, on a
 * consumables form), a free-text Kategorie and Lagerort (so every typo made a
 * new one), an Artikelnummer the server assigns anyway, and a BG-Prüfpflicht
 * toggle that only means something for a tool with units. It had no Einheit,
 * which is the field that decides whether a drum of cable is counted in metres
 * or in pieces.
 *
 * What is here instead is what a consumable actually needs, with the two
 * taxonomies as selects over the real lists so the same shelf keeps one name.
 *
 * Presentational and controlled: the host dialog owns the values, runs the
 * request and decides what "save" means. The one thing this component decides
 * is that the STARTBESTAND field exists on a create and never on an edit —
 * stock is the ledger's answer, and an edit form that offers to overwrite it
 * is offering something the API rightly refuses.
 */
import type { WerkstattCategory, WerkstattLocation, WerkstattSupplier } from "../../types/werkstatt";
import { UNIT_OPTIONS, withField, type ArtikelFormValues } from "./artikelForm";
import { unitLabel } from "./unitLabel";

export interface ArtikelFormFieldsProps {
  de: boolean;
  values: ArtikelFormValues;
  onChange: (next: ArtikelFormValues) => void;
  categories: ReadonlyArray<WerkstattCategory>;
  locations: ReadonlyArray<WerkstattLocation>;
  suppliers: ReadonlyArray<WerkstattSupplier>;
  /** "create" shows Startbestand; "edit" shows the live counters read-only. */
  mode: "create" | "edit";
  /** Edit only: what the ledger currently says, and the way to change it. */
  stock?: { total: number; available: number; unit: string | null } | null;
  onOpenStockDialog?: () => void;
  onCreateCategory?: () => void;
  onCreateLocation?: () => void;
  disabled?: boolean;
}

const OTHER_UNIT = "__other__";

export function ArtikelFormFields({
  de,
  values,
  onChange,
  categories,
  locations,
  suppliers,
  mode,
  stock,
  onOpenStockDialog,
  onCreateCategory,
  onCreateLocation,
  disabled = false,
}: ArtikelFormFieldsProps) {
  const set = <K extends keyof ArtikelFormValues>(field: K, value: ArtikelFormValues[K]) =>
    onChange(withField(values, field, value));

  const unitIsListed = values.unit === "" || UNIT_OPTIONS.includes(values.unit as never);

  return (
    <div className="werkstatt-modal-form stock-form">
      <div className="stock-form-row">
        <label className="werkstatt-field werkstatt-field--grow">
          <span className="werkstatt-field-label">
            {de ? "Bezeichnung" : "Item name"}
            <span className="werkstatt-required">*</span>
          </span>
          <input
            type="text"
            className="werkstatt-field-input"
            value={values.item_name}
            disabled={disabled}
            autoFocus={mode === "create"}
            onChange={(event) => set("item_name", event.target.value)}
          />
        </label>
        <label className="werkstatt-field stock-form-field--third">
          <span className="werkstatt-field-label">{de ? "Hersteller" : "Manufacturer"}</span>
          <input
            type="text"
            className="werkstatt-field-input"
            value={values.manufacturer}
            disabled={disabled}
            onChange={(event) => set("manufacturer", event.target.value)}
          />
        </label>
      </div>

      <div className="stock-form-row">
        <label className="werkstatt-field stock-form-field--half">
          <span className="werkstatt-field-label">EAN / GTIN</span>
          <div className="werkstatt-field-input-wrap">
            <input
              type="text"
              className="werkstatt-field-input"
              value={values.ean}
              /* A scanned code is right; retyping it by hand is how the wrong
                 product gets the right barcode. Unlocking is one click and
                 deliberate. */
              readOnly={values.ean_locked}
              disabled={disabled}
              placeholder={de ? "gescannt oder eingetippt" : "scanned or typed"}
              onChange={(event) => set("ean", event.target.value)}
            />
            {values.ean_locked && (
              <button
                type="button"
                className="werkstatt-field-suffix stock-form-unlock"
                disabled={disabled}
                onClick={() => set("ean_locked", false)}
              >
                {de ? "ändern" : "change"}
              </button>
            )}
          </div>
        </label>

        <label className="werkstatt-field stock-form-field--quarter">
          <span className="werkstatt-field-label">
            {de ? "Einheit" : "Unit"}
          </span>
          <select
            className="werkstatt-field-select"
            value={unitIsListed ? values.unit : OTHER_UNIT}
            disabled={disabled}
            onChange={(event) =>
              set("unit", event.target.value === OTHER_UNIT ? " " : event.target.value)
            }
          >
            <option value="">
              {de ? `Standard (${unitLabel(null, true)})` : `Default (${unitLabel(null, false)})`}
            </option>
            {UNIT_OPTIONS.map((unit) => (
              <option key={unit} value={unit}>
                {unit}
              </option>
            ))}
            <option value={OTHER_UNIT}>{de ? "andere…" : "other…"}</option>
          </select>
        </label>
        {!unitIsListed && (
          <label className="werkstatt-field stock-form-field--quarter">
            <span className="werkstatt-field-label">{de ? "Eigene Einheit" : "Custom unit"}</span>
            <input
              type="text"
              className="werkstatt-field-input"
              value={values.unit.trim()}
              disabled={disabled}
              maxLength={64}
              onChange={(event) => set("unit", event.target.value)}
            />
          </label>
        )}
      </div>

      <div className="stock-form-row">
        <label className="werkstatt-field werkstatt-field--grow">
          <span className="werkstatt-field-label">{de ? "Kategorie" : "Category"}</span>
          <div className="stock-form-inline">
            <select
              className="werkstatt-field-select"
              value={values.category_id == null ? "" : String(values.category_id)}
              disabled={disabled}
              onChange={(event) =>
                set("category_id", event.target.value ? Number(event.target.value) : null)
              }
            >
              <option value="">{de ? "— keine —" : "— none —"}</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
            {onCreateCategory && (
              <button
                type="button"
                className="werkstatt-action-btn stock-form-add"
                disabled={disabled}
                onClick={onCreateCategory}
              >
                {de ? "+ Neue Kategorie" : "+ New category"}
              </button>
            )}
          </div>
        </label>
        <label className="werkstatt-field werkstatt-field--grow">
          <span className="werkstatt-field-label">{de ? "Lagerort" : "Location"}</span>
          <div className="stock-form-inline">
            <select
              className="werkstatt-field-select"
              value={values.location_id == null ? "" : String(values.location_id)}
              disabled={disabled}
              onChange={(event) =>
                set("location_id", event.target.value ? Number(event.target.value) : null)
              }
            >
              <option value="">{de ? "— keiner —" : "— none —"}</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
            {onCreateLocation && (
              <button
                type="button"
                className="werkstatt-action-btn stock-form-add"
                disabled={disabled}
                onClick={onCreateLocation}
              >
                {de ? "+ Neuer Lagerort" : "+ New location"}
              </button>
            )}
          </div>
        </label>
      </div>

      <div className="stock-form-row">
        {mode === "create" ? (
          <label className="werkstatt-field stock-form-field--third">
            <span className="werkstatt-field-label">
              {de ? "Startbestand" : "Starting stock"}
            </span>
            <input
              type="number"
              min={0}
              className="werkstatt-field-input"
              value={values.stock_total}
              disabled={disabled}
              onChange={(event) => set("stock_total", event.target.value)}
            />
          </label>
        ) : (
          /* Read-only on purpose: the counters are derived from the movement
             ledger, so a field here would be a number the server discards.
             The link goes where a real booking can be made. */
          <div className="werkstatt-field stock-form-field--third">
            <span className="werkstatt-field-label">{de ? "Bestand" : "Stock"}</span>
            <div className="stock-form-readonly">
              <b>
                {stock?.available ?? 0} / {stock?.total ?? 0}{" "}
                {unitLabel(stock?.unit ?? values.unit, de)}
              </b>
              {onOpenStockDialog && (
                <button
                  type="button"
                  className="werkstatt-card-action"
                  disabled={disabled}
                  onClick={onOpenStockDialog}
                >
                  {de ? "Bestand anpassen" : "Adjust stock"}
                </button>
              )}
            </div>
          </div>
        )}
        <label className="werkstatt-field stock-form-field--third">
          <span className="werkstatt-field-label">{de ? "Mindestbestand" : "Minimum stock"}</span>
          <input
            type="number"
            min={0}
            className="werkstatt-field-input"
            value={values.stock_min}
            disabled={disabled}
            onChange={(event) => set("stock_min", event.target.value)}
          />
        </label>
        <label className="werkstatt-field stock-form-field--third">
          <span className="werkstatt-field-label">{de ? "Einkaufspreis" : "Purchase price"}</span>
          <div className="werkstatt-field-input-wrap">
            <input
              type="text"
              inputMode="decimal"
              className="werkstatt-field-input"
              value={values.price_eur}
              disabled={disabled}
              placeholder="0,00"
              onChange={(event) => set("price_eur", event.target.value)}
            />
            <span className="werkstatt-field-suffix">€ {de ? "netto" : "net"}</span>
          </div>
        </label>
      </div>

      <div className="stock-form-row">
        <label className="werkstatt-field werkstatt-field--grow">
          <span className="werkstatt-field-label">
            {de ? "Lieferant (optional)" : "Supplier (optional)"}
          </span>
          <select
            className="werkstatt-field-select"
            value={values.supplier_id == null ? "" : String(values.supplier_id)}
            disabled={disabled}
            onChange={(event) =>
              set("supplier_id", event.target.value ? Number(event.target.value) : null)
            }
          >
            <option value="">{de ? "— keiner —" : "— none —"}</option>
            {suppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name}
              </option>
            ))}
          </select>
        </label>
        <label className="werkstatt-field werkstatt-field--grow">
          <span className="werkstatt-field-label">
            {de ? "Lieferanten-Art.-Nr." : "Supplier article no."}
          </span>
          <input
            type="text"
            className="werkstatt-field-input"
            value={values.supplier_article_no}
            disabled={disabled || values.supplier_id == null}
            placeholder={
              values.supplier_id == null
                ? de
                  ? "erst Lieferant wählen"
                  : "pick a supplier first"
                : ""
            }
            onChange={(event) => set("supplier_article_no", event.target.value)}
          />
        </label>
      </div>

      {values.image_url && (
        <div className="stock-form-image">
          <img src={values.image_url} alt="" />
          <button
            type="button"
            className="werkstatt-action-btn"
            disabled={disabled}
            onClick={() => set("image_url", null)}
          >
            {de ? "Bild entfernen" : "Remove image"}
          </button>
        </div>
      )}

      <label className="werkstatt-field">
        <span className="werkstatt-field-label">{de ? "Notizen" : "Notes"}</span>
        <textarea
          className="werkstatt-field-input stock-form-notes"
          rows={2}
          value={values.notes}
          disabled={disabled}
          onChange={(event) => set("notes", event.target.value)}
        />
      </label>
    </div>
  );
}
