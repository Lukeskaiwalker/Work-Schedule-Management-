/**
 * ArtikelSuchfeld — one search box, two sources, and a way out when both miss.
 *
 * An order line can be three things (see the server's `build_order_line`):
 * one of our own stocked articles, a row of the supplier's Datanorm
 * catalogue, or free text. The picker searches the first two at once,
 * because the buyer does not know — and should not have to know — whether
 * "NYY-J 5x6" is on a shelf here or only in Unielektro's list. The catalogue
 * hit is the one that carries the supplier's article number, which is what
 * the shop needs back; picking it puts that number on the line from the
 * start instead of hoping the resolver finds it at submit time.
 *
 * The "Freie Position" row at the bottom covers what neither source knows.
 * It stays visible even with hits, so a buyer who typed a description that
 * happens to partially match something is never forced to pick it.
 *
 * Shared by the "Neue Bestellung" modal and the order drawer; both hand a
 * picked hit to `hitToOrderLine`, so the two paths send identical payloads.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import type { Language } from "../../types";
import type { MaterialCatalogItemLite } from "../../types/werkstatt";
import type { OrderLineCreate } from "../../types/werkstattProcurement";
import { listArticles, type WerkstattArticleLite } from "../../utils/werkstattArticlesApi";
import { searchWerkstattCatalog } from "../../utils/werkstattCatalogApi";

export type ArtikelSuchTreffer =
  | { kind: "article"; article: WerkstattArticleLite }
  | { kind: "catalog"; item: MaterialCatalogItemLite }
  /**
   * A catalogue row picked under one supplier and kept after the order was
   * moved to another (see `detachFromSupplier`). The row id is gone — it
   * would be refused — but the product's EAN, manufacturer and unit stay,
   * which is what lets the new supplier's catalogue find it again.
   */
  | { kind: "detached"; item: MaterialCatalogItemLite }
  | { kind: "free"; description: string; unitPriceCents: number | null };

/** Stable identity for de-duplicating a cart: the same hit twice increments. */
export function hitKey(hit: ArtikelSuchTreffer): string {
  switch (hit.kind) {
    case "article":
      return `article:${hit.article.id}`;
    case "catalog":
      return `catalog:${hit.item.id}`;
    case "detached":
      return `detached:${hit.item.id}`;
    default:
      return `free:${hit.description.trim().toLowerCase()}`;
  }
}

export function hitLabel(hit: ArtikelSuchTreffer): string {
  switch (hit.kind) {
    case "article":
      return hit.article.item_name;
    case "catalog":
    case "detached":
      return hit.item.item_name;
    default:
      return hit.description;
  }
}

/** The supplier number a hit will carry, when it is known up front. */
export function hitSupplierNo(hit: ArtikelSuchTreffer): string | null {
  switch (hit.kind) {
    case "article":
      return hit.article.supplier_article_no ?? null;
    case "catalog":
      return hit.item.article_no;
    default:
      // A detached row's number was the OLD supplier's; it must not travel.
      return null;
  }
}

export function hitUnit(hit: ArtikelSuchTreffer): string | null {
  switch (hit.kind) {
    case "article":
      return hit.article.unit;
    case "catalog":
    case "detached":
      return hit.item.unit;
    default:
      return null;
  }
}

/**
 * The line payload for a hit. Only identity and quantity travel: the server
 * snapshots name, EAN, unit and the supplier's number from the article or
 * catalogue row itself, so the browser cannot send a stale copy. A detached
 * row has no server-side identity left, so it travels as a free line WITH
 * the product facts the resolver needs — the EAN above all.
 */
export function hitToOrderLine(hit: ArtikelSuchTreffer, quantity: number): OrderLineCreate {
  const quantity_ordered = Math.max(1, Math.floor(quantity));
  switch (hit.kind) {
    case "article":
      return { article_id: hit.article.id, quantity_ordered };
    case "catalog":
      return { catalog_item_id: hit.item.id, quantity_ordered };
    case "detached":
      return {
        description: hit.item.item_name,
        ean: hit.item.ean,
        manufacturer: hit.item.manufacturer,
        unit: hit.item.unit,
        quantity_ordered,
      };
    default:
      return {
        description: hit.description.trim(),
        quantity_ordered,
        unit_price_cents: hit.unitPriceCents,
      };
  }
}

/**
 * A catalogue hit re-homed to another supplier: the row id would be refused
 * (a Sonepar row on a Unielektro order orders the wrong product), but the
 * EAN is global and lets the new supplier's catalogue resolve it — so the
 * EAN, manufacturer and unit are kept, not dropped with the row.
 */
export function detachFromSupplier(hit: ArtikelSuchTreffer): ArtikelSuchTreffer {
  if (hit.kind !== "catalog") return hit;
  return { kind: "detached", item: hit.item };
}

/** German comma or English dot, both to cents. Empty means "no price". */
export function parsePriceCents(raw: string): number | null {
  const text = raw.trim().replace(",", ".");
  if (!text) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

const DEBOUNCE_MS = 220;
const HIT_LIMIT = 20;
const EAN_SHAPE = /^\d{8,14}$/;

export interface ArtikelSuchfeldProps {
  token: string | null;
  language: Language;
  /** The order's supplier. Catalogue rows belong to exactly one. */
  supplierId: number | null;
  supplierName?: string | null;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Free lines carry a quantity of their own; article/catalogue picks add one. */
  onPick: (hit: ArtikelSuchTreffer, quantity: number) => void;
}

interface Hits {
  articles: WerkstattArticleLite[];
  catalog: MaterialCatalogItemLite[];
}

const NO_HITS: Hits = { articles: [], catalog: [] };

export function ArtikelSuchfeld({
  token,
  language,
  supplierId,
  supplierName,
  disabled = false,
  autoFocus = false,
  onPick,
}: ArtikelSuchfeldProps) {
  const de = language === "de";
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hits>(NO_HITS);
  const [searching, setSearching] = useState(false);
  const [freeDescription, setFreeDescription] = useState("");
  const [freeQuantity, setFreeQuantity] = useState("1");
  const [freePrice, setFreePrice] = useState("");
  // A fast typist gets several responses in flight; only the newest may
  // render, or a stale "no hits" can overwrite a real result.
  const requestSeq = useRef(0);

  useEffect(() => {
    const needle = query.trim();
    if (!needle || disabled) {
      setHits(NO_HITS);
      return;
    }
    const seq = ++requestSeq.current;
    const handle = window.setTimeout(async () => {
      setSearching(true);
      const [articles, catalog] = await Promise.allSettled([
        // Every stocked article that matches, each annotated with what THIS
        // supplier calls it. Not `supplierId`: that filters to articles
        // already linked to the supplier, and the one the buyer is about to
        // number for the first time is precisely the one without a link.
        listArticles(token, { q: needle, annotateSupplierId: supplierId, limit: HIT_LIMIT }),
        // Without a supplier there is no catalogue to search: a row must
        // belong to the order's supplier or the server refuses it.
        supplierId === null
          ? Promise.resolve([])
          : searchWerkstattCatalog(token, { q: needle, supplierId, limit: HIT_LIMIT }),
      ]);
      if (seq !== requestSeq.current) return;
      setSearching(false);
      setHits({
        articles: rankExactEan(
          articles.status === "fulfilled" ? articles.value : [],
          needle,
          (row) => row.ean,
        ),
        catalog: rankExactEan(
          catalog.status === "fulfilled"
            ? catalog.value.flatMap((group) => group.suppliers)
            : [],
          needle,
          (row) => row.ean,
        ),
      });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [query, supplierId, token, disabled]);

  const hasQuery = query.trim().length > 0;
  const nothingFound = hasQuery && !searching && hits.articles.length === 0 && hits.catalog.length === 0;

  const catalogTitle = useMemo(() => {
    const base = de ? "Katalog" : "Catalogue";
    return supplierName ? `${base} ${supplierName}` : base;
  }, [de, supplierName]);

  function submitFree() {
    const description = freeDescription.trim() || query.trim();
    const quantity = Number(freeQuantity);
    if (!description || !Number.isFinite(quantity) || quantity < 1) return;
    onPick(
      { kind: "free", description, unitPriceCents: parsePriceCents(freePrice) },
      Math.floor(quantity),
    );
    setFreeDescription("");
    setFreeQuantity("1");
    setFreePrice("");
  }

  const addLabel = (name: string) => (de ? `${name} hinzufügen` : `Add ${name}`);

  return (
    <div className="werkstatt-artikelsuche">
      <input
        className="werkstatt-field-input"
        type="search"
        autoFocus={autoFocus}
        disabled={disabled}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={
          de
            ? "Artikel suchen — Name, EAN oder SP-Nummer"
            : "Search articles — name, EAN or SP number"
        }
        aria-label={de ? "Artikel suchen" : "Search articles"}
      />

      <div className="werkstatt-artikelsuche-results">
        {hits.articles.length > 0 && (
          <section>
            <h4 className="werkstatt-artikelsuche-section-title">
              {de ? "Eigene Artikel" : "Own articles"}
            </h4>
            <ul className="werkstatt-artikelsuche-list">
              {hits.articles.map((article) => (
                <li key={article.id} className="werkstatt-artikelsuche-hit">
                  <div className="werkstatt-artikelsuche-hit-main">
                    <b>{article.item_name}</b>
                    <small>
                      {[
                        article.article_number,
                        article.ean ? `EAN ${article.ean}` : null,
                        `${article.stock_available} ${article.unit ?? (de ? "Stk" : "pcs")} ${de ? "verfügbar" : "available"}`,
                        article.supplier_article_no
                          ? `${de ? "Lieferanten-Nr." : "Supplier no."} ${article.supplier_article_no}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                  </div>
                  <button
                    type="button"
                    className="werkstatt-artikelsuche-add"
                    disabled={disabled}
                    aria-label={addLabel(article.item_name)}
                    onClick={() => onPick({ kind: "article", article }, 1)}
                  >
                    +
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {hits.catalog.length > 0 && (
          <section>
            <h4 className="werkstatt-artikelsuche-section-title">{catalogTitle}</h4>
            <ul className="werkstatt-artikelsuche-list">
              {hits.catalog.map((item) => (
                <li key={item.id} className="werkstatt-artikelsuche-hit">
                  <div className="werkstatt-artikelsuche-hit-main">
                    <b>{item.item_name}</b>
                    <small>
                      {[
                        item.article_no ? `Art.-Nr. ${item.article_no}` : null,
                        item.ean ? `EAN ${item.ean}` : null,
                        item.manufacturer,
                        item.price_text,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                  </div>
                  <button
                    type="button"
                    className="werkstatt-artikelsuche-add"
                    disabled={disabled}
                    aria-label={addLabel(item.item_name)}
                    onClick={() => onPick({ kind: "catalog", item }, 1)}
                  >
                    +
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {searching && (
          <p className="werkstatt-artikelsuche-empty">{de ? "Suche…" : "Searching…"}</p>
        )}
        {nothingFound && (
          <p className="werkstatt-artikelsuche-empty">
            {supplierId === null
              ? de
                ? "Kein Treffer bei den eigenen Artikeln. Für den Katalog zuerst einen Lieferanten wählen."
                : "No match among own articles. Choose a supplier to search the catalogue."
              : de
                ? "Weder eigener Artikel noch Katalogeintrag — unten als freie Position anlegen."
                : "Neither an own article nor a catalogue row — add it as a free item below."}
          </p>
        )}
        {!hasQuery && (
          <p className="werkstatt-artikelsuche-empty">
            {de
              ? "Tippen, um eigene Artikel und den Lieferantenkatalog zu durchsuchen."
              : "Type to search own articles and the supplier's catalogue."}
          </p>
        )}

        <div className="werkstatt-artikelsuche-free">
          <input
            className="werkstatt-field-input"
            disabled={disabled}
            value={freeDescription}
            onChange={(event) => setFreeDescription(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitFree();
            }}
            placeholder={
              hasQuery
                ? de
                  ? `„${query.trim()}“ als freie Position`
                  : `“${query.trim()}” as free item`
                : de
                  ? "Freie Position — Bezeichnung"
                  : "Free item — description"
            }
            aria-label={de ? "Freie Position" : "Free item"}
          />
          <input
            className="werkstatt-field-input werkstatt-orders-qty-input"
            type="number"
            min={1}
            disabled={disabled}
            value={freeQuantity}
            onChange={(event) => setFreeQuantity(event.target.value)}
            aria-label={de ? "Menge der freien Position" : "Free item quantity"}
          />
          <input
            className="werkstatt-field-input werkstatt-orders-price-input"
            inputMode="decimal"
            disabled={disabled}
            placeholder={de ? "€ netto" : "€ net"}
            value={freePrice}
            onChange={(event) => setFreePrice(event.target.value)}
            aria-label={de ? "Einzelpreis der freien Position" : "Free item unit price"}
          />
          <button
            type="button"
            className="werkstatt-action-btn"
            disabled={disabled || !(freeDescription.trim() || query.trim())}
            onClick={submitFree}
          >
            {de ? "Freie Position" : "Free item"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * An exact EAN typed (or scanned) into the box must come first. The server
 * ranks by name, and a 13-digit code that also appears inside another row's
 * search text would otherwise sort a stranger above the scanned box.
 */
function rankExactEan<T>(rows: T[], needle: string, eanOf: (row: T) => string | null): T[] {
  if (!EAN_SHAPE.test(needle)) return rows;
  const key = needle.replace(/^0+/, "");
  const exact = rows.filter((row) => (eanOf(row) ?? "").replace(/^0+/, "") === key);
  if (exact.length === 0) return rows;
  const rest = rows.filter((row) => !exact.includes(row));
  return [...exact, ...rest];
}
