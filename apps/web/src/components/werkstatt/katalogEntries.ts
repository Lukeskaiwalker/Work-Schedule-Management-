/**
 * Pure helpers for the Datanorm catalogue page.
 *
 * Kept out of the page so the arithmetic that decides what the user is told —
 * how many rows came back, whether the result was cut off, which picture a
 * card shows — can be tested without mounting anything.
 */
import type { MaterialCatalogItem } from "../../types";
import type {
  MaterialCatalogItemLite,
  WerkstattCatalogGroup,
  WerkstattSupplier,
} from "../../types/werkstatt";

/**
 * How many catalogue ROWS one search asks for.
 *
 * Rows, not products: `/werkstatt/catalog/search` caps the rows it reads and
 * only then folds rows sharing an EAN into one card, so 60 rows can be far
 * fewer cards. 60 keeps a page worth scrolling while staying well under the
 * endpoint's own ceiling of 120.
 */
export const KATALOG_SEARCH_LIMIT = 60;

/**
 * How many rows one search ASKS the server for: one more than it shows.
 *
 * A result that is exactly as long as the cap is ambiguous — it means either
 * "cut off here" or "this is all there is" — and the page used to resolve that
 * ambiguity by claiming hits that did not exist, sending the buyer off to
 * narrow a search that was already complete. Fetching one row beyond what is
 * rendered turns the question into a fact: 61 rows back means there is a 61st,
 * 60 means the pool is exhausted. The endpoint's own ceiling is 120.
 */
export const KATALOG_FETCH_LIMIT = KATALOG_SEARCH_LIMIT + 1;

/** Supplier rows across all groups — what the server actually counted against
 *  the limit, and therefore the only number that can tell us it truncated. */
export function countCatalogRows(
  groups: ReadonlyArray<WerkstattCatalogGroup>,
): number {
  return groups.reduce((sum, group) => sum + group.suppliers.length, 0);
}

/**
 * True when there is at least one hit beyond the page.
 *
 * Takes the RAW response, which was fetched with `KATALOG_FETCH_LIMIT`:
 * strictly MORE rows than the page renders is the only evidence that
 * something was left behind. Saying so is the difference between "no such
 * article" and "not on this page of results" — and NOT saying it when the
 * pool happens to hold exactly `limit` rows is the difference between an
 * honest note and an invented one.
 */
export function isTruncated(
  groups: ReadonlyArray<WerkstattCatalogGroup>,
  limit: number = KATALOG_SEARCH_LIMIT,
): boolean {
  return countCatalogRows(groups) > limit;
}

/**
 * The first `limit` ROWS of the result, as whole-or-partial groups.
 *
 * The probe row fetched beyond the cap is for counting, not for showing: it
 * would otherwise make the page render 61 rows while the note talks about 60.
 * Rows are dropped from the tail, so a group's hero (its first row) survives
 * whenever any of its rows do.
 */
export function trimToRowLimit(
  groups: ReadonlyArray<WerkstattCatalogGroup>,
  limit: number = KATALOG_SEARCH_LIMIT,
): WerkstattCatalogGroup[] {
  const kept: WerkstattCatalogGroup[] = [];
  let budget = limit;
  for (const group of groups) {
    if (budget <= 0) break;
    if (group.suppliers.length <= budget) {
      kept.push(group);
      budget -= group.suppliers.length;
      continue;
    }
    kept.push({ ...group, suppliers: group.suppliers.slice(0, budget) });
    budget = 0;
  }
  return kept;
}

/**
 * The supplier's own standard lead time, keyed by supplier id.
 *
 * A Datanorm row carries no delivery time — the page used to print "0
 * Werktage" beside every single article, which read as "available tomorrow"
 * and was simply a zero nobody had filled in. What DOES exist is the lead
 * time recorded on the supplier, so that is what the offers show, and the
 * wording says whose figure it is.
 */
export function supplierLeadTimes(
  suppliers: ReadonlyArray<WerkstattSupplier>,
): ReadonlyMap<number, number> {
  const entries = suppliers
    .filter((supplier) => supplier.default_lead_time_days != null)
    .map((supplier): [number, number] => [
      supplier.id,
      supplier.default_lead_time_days as number,
    ]);
  return new Map(entries);
}

/** The picture for a card: the first supplier row that actually has one.
 *  Rows sharing an EAN are the same product, and only one of the wholesalers
 *  usually ships an image for it. */
export function groupImage(group: WerkstattCatalogGroup): MaterialCatalogItemLite | null {
  if (group.hero.image_url) return group.hero;
  return group.suppliers.find((row) => row.image_url) ?? null;
}

/** Replace the image of every row carrying `externalKey`, in a new array.
 *  A catalogue row is identified by its external key everywhere the image
 *  endpoints are concerned, and the same key can appear in more than one
 *  group after a re-import. */
export function withCatalogImage(
  groups: ReadonlyArray<WerkstattCatalogGroup>,
  externalKey: string,
  imageUrl: string | null,
): WerkstattCatalogGroup[] {
  const patch = (row: MaterialCatalogItemLite): MaterialCatalogItemLite =>
    row.external_key === externalKey ? { ...row, image_url: imageUrl } : row;
  return groups.map((group) => ({
    ...group,
    hero: patch(group.hero),
    suppliers: group.suppliers.map(patch),
  }));
}

/**
 * A catalogue row in the shape the "Neuer Bedarf" dialog still asks for.
 *
 * That dialog is typed against the legacy `/materials/catalog` row. It reads
 * id, item_name, article_no, manufacturer and unit — all of which the
 * Werkstatt catalogue row carries — and never touches the two provenance
 * fields, which the Werkstatt endpoint does not return. They are left empty
 * rather than filled with a plausible-looking file name: an invented source
 * would outlive this conversion.
 */
export function toBedarfSeed(row: MaterialCatalogItemLite): MaterialCatalogItem {
  return {
    id: row.id,
    external_key: row.external_key,
    article_no: row.article_no,
    item_name: row.item_name,
    unit: row.unit,
    manufacturer: row.manufacturer,
    ean: row.ean,
    price_text: row.price_text,
    image_url: row.image_url,
    source_file: "",
    source_line: 0,
  };
}

/**
 * How many distinct suppliers list this product.
 *
 * Counted over supplier ids, not rows: one wholesaler can have two Datanorm
 * rows for the same EAN, and "2 Lieferanten" would then be a second supplier
 * that does not exist. Rows with no supplier link (a catalogue imported
 * before suppliers were modelled) count for nobody, which is why the card
 * says "ohne Lieferant" instead of "0 Lieferanten".
 */
export function groupSupplierCount(group: WerkstattCatalogGroup): number {
  const ids = group.suppliers
    .map((row) => row.supplier_id)
    .filter((id): id is number => id != null);
  return new Set(ids).size;
}

/**
 * What the tag beside a product's name may honestly say about its suppliers.
 *
 * `groupSupplierCount` counts the rows the SERVER returned, and the server
 * filters by supplier before it groups and cuts at a row cap before it
 * answers. Printed as a bare "1 Lieferant" beside the product name, that count
 * reads as a property of the product — "only one wholesaler carries this" —
 * which is a claim about the whole catalogue made from one page of it. So the
 * two cases where the number cannot mean that say what it does mean instead:
 *
 * - a supplier chip is active: every group holds exactly that supplier's rows
 *   by construction, so the count carries no information at all;
 * - the result was cut off: a product listed by three wholesalers whose third
 *   row fell past the cap would otherwise read "2 Lieferanten".
 */
export interface SupplierTagContext {
  de: boolean;
  /** A supplier chip is active, so the server returned one supplier's rows. */
  filtered: boolean;
  /** The row cap cut the result, so a product's rows can be split across it. */
  truncated: boolean;
}

export function supplierTagText(
  group: WerkstattCatalogGroup,
  ctx: SupplierTagContext,
): string {
  const { de, filtered, truncated } = ctx;
  if (filtered) return de ? "Treffer bei diesem Lieferanten" : "hit at this supplier";
  const count = groupSupplierCount(group);
  if (count === 0) return de ? "ohne Lieferant" : "no supplier";
  const noun =
    count === 1 ? (de ? "Lieferant" : "supplier") : de ? "Lieferanten" : "suppliers";
  if (truncated) {
    return de ? `${count} ${noun} auf dieser Seite` : `${count} ${noun} on this page`;
  }
  return `${count} ${noun}`;
}

/** How to name one catalogue row to a buyer: whose row it is, else the number
 *  printed on the card, else the product itself. */
export function rowLabel(row: MaterialCatalogItemLite, de: boolean): string {
  if (row.supplier_name?.trim()) return row.supplier_name.trim();
  if (row.article_no?.trim()) return `Art.-Nr. ${row.article_no.trim()}`;
  return row.item_name || (de ? "diese Zeile" : "this row");
}

/** What removing one row's picture does to the card: which row it is taken
 *  from, and which row the card falls back to afterwards (if any). */
export interface CatalogImageDeletion {
  removed: MaterialCatalogItemLite | null;
  /** Another supplier's row for the same EAN, whose picture the card shows
   *  from now on. Null when the card really is left without a picture. */
  fallback: MaterialCatalogItemLite | null;
}

/**
 * What an image deletion will do to the card it was clicked on.
 *
 * `groupImage` falls through to the next row that carries a picture, so
 * deleting the displayed one can leave a DIFFERENT wholesaler's picture in
 * exactly the same place. Announced as a plain "Bild entfernt." that is
 * indistinguishable from nothing having happened, and the next click destroys
 * the second wholesaler's image too. This reports both facts so the notice can
 * name them; the list itself is updated with `withCatalogImage`.
 */
export function describeImageDeletion(
  groups: ReadonlyArray<WerkstattCatalogGroup>,
  externalKey: string,
): CatalogImageDeletion {
  const sourceGroup = groups.find((group) =>
    group.suppliers.some((row) => row.external_key === externalKey),
  );
  if (!sourceGroup) return { removed: null, fallback: null };
  const removed =
    sourceGroup.suppliers.find((row) => row.external_key === externalKey) ?? null;
  const [nextGroup] = withCatalogImage([sourceGroup], externalKey, null);
  const fallback = groupImage(nextGroup);
  return {
    removed,
    // A row with no picture is no fallback — `groupImage` answers the hero
    // when nothing has one at all.
    fallback: fallback?.image_url ? fallback : null,
  };
}

/** What to tell the user after a successful delete. Never promises a
 *  replacement picture (nothing guarantees the scraper finds one, and a
 *  hand-uploaded original is simply gone), and never hides a substitution. */
export function imageRemovedMessage(deletion: CatalogImageDeletion, de: boolean): string {
  const from = deletion.removed ? rowLabel(deletion.removed, de) : null;
  const head = from
    ? de
      ? `Bild von ${from} entfernt.`
      : `Image from ${from} removed.`
    : de
      ? "Bild entfernt."
      : "Image removed.";
  if (!deletion.fallback) return head;
  const other = rowLabel(deletion.fallback, de);
  return de
    ? `${head} Angezeigt wird jetzt das Bild von ${other} zur selben EAN.`
    : `${head} The card now shows ${other}'s image for the same EAN.`;
}
