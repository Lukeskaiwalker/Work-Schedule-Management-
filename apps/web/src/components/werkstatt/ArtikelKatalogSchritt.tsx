/**
 * The catalogue branch of "Neuer Lagerartikel": pick a product, then say what
 * the catalogue cannot know.
 *
 * Creating from a Datanorm row is the best case — the wholesaler's own name,
 * EAN, manufacturer and article number, and the server links every supplier
 * that lists the same EAN — so this branch deliberately does NOT offer the
 * full form. Editing the name here would only produce an article that
 * disagrees with the invoice.
 *
 * What it does ask for is the four things no catalogue has an opinion about:
 * how many just arrived, when to warn, which category and which shelf. Without
 * them "create from catalogue" quietly means "create a zero-stock row with no
 * location that somebody has to finish later", which is the shape of
 * half-finished data this whole feature exists to stop producing.
 */
import type {
  WerkstattCatalogGroup,
  WerkstattCategory,
  WerkstattLocation,
} from "../../types/werkstatt";
import { KatalogPicker } from "./KatalogPicker";
import type { ArtikelFormValues } from "./artikelForm";

export interface ArtikelKatalogSchrittProps {
  de: boolean;
  language: "de" | "en";
  groups: ReadonlyArray<WerkstattCatalogGroup>;
  pickedGroup: WerkstattCatalogGroup | null;
  pickedSuppliers: ReadonlySet<number>;
  loading: boolean;
  busy: boolean;
  values: ArtikelFormValues;
  categories: ReadonlyArray<WerkstattCategory>;
  locations: ReadonlyArray<WerkstattLocation>;
  search: { value: string; onChange: (value: string) => void };
  onPickGroup: (group: WerkstattCatalogGroup) => void;
  onToggleSupplier: (catalogItemId: number) => void;
  onChangeValues: (next: ArtikelFormValues) => void;
}

export function ArtikelKatalogSchritt({
  de,
  language,
  groups,
  pickedGroup,
  pickedSuppliers,
  loading,
  busy,
  values,
  categories,
  locations,
  search,
  onPickGroup,
  onToggleSupplier,
  onChangeValues,
}: ArtikelKatalogSchrittProps) {
  const set = <K extends keyof ArtikelFormValues>(field: K, value: ArtikelFormValues[K]) =>
    onChangeValues({ ...values, [field]: value });

  return (
    <>
      <KatalogPicker
        groups={groups}
        selectedCatalogItemId={pickedGroup?.hero.id ?? null}
        selectedSupplierIds={pickedSuppliers}
        loading={loading}
        onToggleSupplier={onToggleSupplier}
        onSelectGroup={onPickGroup}
        language={language}
        search={search}
      />

      <div className="stock-form stock-form--catalog">
        <div className="stock-form-row">
          <label className="werkstatt-field stock-form-field--quarter">
            <span className="werkstatt-field-label">
              {de ? "Startbestand" : "Starting stock"}
            </span>
            <input
              type="number"
              min={0}
              className="werkstatt-field-input"
              value={values.stock_total}
              disabled={busy}
              onChange={(event) => set("stock_total", event.target.value)}
            />
          </label>
          <label className="werkstatt-field stock-form-field--quarter">
            <span className="werkstatt-field-label">
              {de ? "Mindestbestand" : "Minimum stock"}
            </span>
            <input
              type="number"
              min={0}
              className="werkstatt-field-input"
              value={values.stock_min}
              disabled={busy}
              onChange={(event) => set("stock_min", event.target.value)}
            />
          </label>
          <label className="werkstatt-field stock-form-field--quarter">
            <span className="werkstatt-field-label">{de ? "Kategorie" : "Category"}</span>
            <select
              className="werkstatt-field-select"
              value={values.category_id == null ? "" : String(values.category_id)}
              disabled={busy}
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
          </label>
          <label className="werkstatt-field stock-form-field--quarter">
            <span className="werkstatt-field-label">{de ? "Lagerort" : "Location"}</span>
            <select
              className="werkstatt-field-select"
              value={values.location_id == null ? "" : String(values.location_id)}
              disabled={busy}
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
          </label>
        </div>
      </div>
    </>
  );
}
