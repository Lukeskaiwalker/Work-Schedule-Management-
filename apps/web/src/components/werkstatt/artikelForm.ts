/**
 * The shape of the article form, and the four conversions around it.
 *
 * Pure functions in their own module for two reasons. The create dialog and
 * the edit dialog render the SAME fields and must produce the same payload —
 * "Einheit" meaning one thing in one dialog and another in the other is
 * exactly how a drum of cable ends up counted in pieces. And a price typed as
 * "1.248,00" has to become 124800 cents identically in both, which is worth
 * testing without mounting a modal.
 *
 * Everything here is immutable: `withField` returns a new object. The form is
 * held in one `useState` in the host dialog, so an in-place edit would not
 * re-render and the field the user is typing in would appear frozen.
 */
import type {
  ArticleCreateInput,
  ArticleUpdateInput,
} from "../../utils/werkstattArticlesApi";
import type { WerkstattArticle, WerkstattExternalHit } from "../../types/werkstatt";

/** The units the workshop actually buys in, plus an escape hatch. */
export const UNIT_OPTIONS = ["Stk", "m", "Pak", "Rolle", "Karton", "Liter"] as const;

export interface ArtikelFormValues {
  item_name: string;
  manufacturer: string;
  ean: string;
  /** A scanned EAN is read-only until somebody presses "ändern" — retyping a
   *  barcode by hand is how the wrong product gets the right code. */
  ean_locked: boolean;
  unit: string;
  category_id: number | null;
  location_id: number | null;
  /** Create only. Booked as an opening intake movement, never assigned. */
  stock_total: string;
  stock_min: string;
  /** As typed, German or English decimals; converted on save. */
  price_eur: string;
  supplier_id: number | null;
  supplier_article_no: string;
  image_url: string | null;
  notes: string;
}

export function emptyArtikelForm(overrides: Partial<ArtikelFormValues> = {}): ArtikelFormValues {
  return {
    item_name: "",
    manufacturer: "",
    ean: "",
    ean_locked: false,
    unit: "",
    category_id: null,
    location_id: null,
    stock_total: "0",
    stock_min: "0",
    price_eur: "",
    supplier_id: null,
    supplier_article_no: "",
    image_url: null,
    notes: "",
    ...overrides,
  };
}

export function withField<K extends keyof ArtikelFormValues>(
  values: ArtikelFormValues,
  field: K,
  value: ArtikelFormValues[K],
): ArtikelFormValues {
  return { ...values, [field]: value };
}

/** Seed the form from a scraped suggestion. The code stays locked: it is the
 *  one field that was not a guess. */
export function artikelFormFromHit(hit: WerkstattExternalHit): ArtikelFormValues {
  return emptyArtikelForm({
    item_name: hit.item_name,
    manufacturer: hit.manufacturer ?? "",
    ean: hit.ean,
    ean_locked: true,
    unit: hit.unit ?? "",
    image_url: hit.image_url,
  });
}

/** Seed the form from an existing article, for the edit dialog. */
export function artikelFormFromArticle(article: WerkstattArticle): ArtikelFormValues {
  const preferred =
    article.suppliers.find((link) => link.is_preferred) ?? article.suppliers[0] ?? null;
  return emptyArtikelForm({
    item_name: article.item_name,
    manufacturer: article.manufacturer ?? "",
    ean: article.ean ?? "",
    // Not locked: an article whose EAN was mistyped years ago is precisely
    // what this dialog exists to fix.
    ean_locked: false,
    unit: article.unit ?? "",
    category_id: article.category_id,
    location_id: article.location_id,
    stock_total: String(article.stock_total),
    stock_min: String(article.stock_min),
    price_eur: centsToInput(article.purchase_price_cents),
    supplier_id: preferred?.supplier_id ?? null,
    supplier_article_no: preferred?.supplier_article_no ?? "",
    image_url: article.image_url,
    notes: article.notes ?? "",
  });
}

/**
 * "1.248,00" / "1248.00" / "1248" → 124800 cents. Blank → null.
 *
 * Accepts both decimal conventions because the workshop types German and the
 * interface can be English; a comma and a dot in the same string means the
 * dot is a thousands separator, which is the German spelling.
 */
export function priceToCents(input: string): number | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d.,-]/g, "");
  if (!cleaned) return null;
  const hasComma = cleaned.includes(",");
  const normalised = hasComma
    ? cleaned.replace(/\./g, "").replace(",", ".")
    : cleaned;
  const value = Number.parseFloat(normalised);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

export function centsToInput(cents: number | null | undefined): string {
  if (cents == null) return "";
  return (cents / 100).toFixed(2).replace(".", ",");
}

function count(input: string): number {
  const value = Number.parseInt((input ?? "").trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function trimmed(value: string): string | null {
  const text = (value ?? "").trim();
  return text ? text : null;
}

/** Why the form cannot be saved yet, or null. German/English per `de`. */
export function artikelFormError(values: ArtikelFormValues, de: boolean): string | null {
  if (!values.item_name.trim()) {
    return de ? "Bezeichnung fehlt." : "The item name is missing.";
  }
  if (values.supplier_article_no.trim() && values.supplier_id == null) {
    return de
      ? "Lieferanten-Art.-Nr. ohne Lieferant — bitte einen Lieferanten wählen."
      : "A supplier article number needs a supplier.";
  }
  return null;
}

/**
 * The create payload.
 *
 * `stock_total` travels as the opening quantity the server books as an intake
 * movement; nothing here ever writes a counter. A supplier is sent as a link
 * (with its article number, when one was typed) rather than as a field on the
 * article, because that link is what every later order resolves against.
 */
export function toCreateInput(
  values: ArtikelFormValues,
  options: { lookupSource?: string | null; imageSource?: "external" | null } = {},
): ArticleCreateInput {
  const supplierLinks =
    values.supplier_id == null
      ? []
      : [
          {
            supplier_id: values.supplier_id,
            supplier_article_no: trimmed(values.supplier_article_no),
            is_preferred: true,
          },
        ];
  return {
    item_name: values.item_name.trim(),
    ean: trimmed(values.ean),
    manufacturer: trimmed(values.manufacturer),
    category_id: values.category_id,
    location_id: values.location_id,
    unit: trimmed(values.unit),
    image_url: values.image_url,
    image_source: values.image_url ? (options.imageSource ?? null) : null,
    stock_total: count(values.stock_total),
    stock_min: count(values.stock_min),
    purchase_price_cents: priceToCents(values.price_eur),
    notes: trimmed(values.notes),
    lookup_source: options.lookupSource ?? null,
    supplier_links: supplierLinks,
  };
}

/**
 * Only what actually changed.
 *
 * A PATCH carrying every field would overwrite a colleague's edit made while
 * this dialog was open, and would send `image_url: null` for an article whose
 * picture this form never showed. Comparing against the row it was seeded from
 * is what keeps the request to the size of the edit.
 */
export function toUpdatePatch(
  values: ArtikelFormValues,
  original: WerkstattArticle,
): ArticleUpdateInput {
  const patch: ArticleUpdateInput = {};
  const name = values.item_name.trim();
  if (name && name !== original.item_name) patch.item_name = name;

  const ean = trimmed(values.ean);
  if (ean !== (original.ean ?? null)) patch.ean = ean;

  const manufacturer = trimmed(values.manufacturer);
  if (manufacturer !== (original.manufacturer ?? null)) patch.manufacturer = manufacturer;

  const unit = trimmed(values.unit);
  if (unit !== (original.unit ?? null)) patch.unit = unit;

  if (values.category_id !== original.category_id) patch.category_id = values.category_id;
  if (values.location_id !== original.location_id) patch.location_id = values.location_id;

  const stockMin = count(values.stock_min);
  if (stockMin !== original.stock_min) patch.stock_min = stockMin;

  const price = priceToCents(values.price_eur);
  if (price !== (original.purchase_price_cents ?? null)) patch.purchase_price_cents = price;

  const notes = trimmed(values.notes);
  if (notes !== (original.notes ?? null)) patch.notes = notes;

  if (values.image_url !== original.image_url) {
    patch.image_url = values.image_url;
    // Dropping the picture drops the claim about where it came from with it.
    patch.image_source = values.image_url ? original.image_source : null;
  }
  return patch;
}

/** True when a patch would change nothing — so the dialog can skip the call. */
export function isEmptyPatch(patch: ArticleUpdateInput): boolean {
  return Object.keys(patch).length === 0;
}
