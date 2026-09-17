import { useEffect, useRef, useState } from "react";
import type { Language, MaterialCatalogItem } from "../../../types";
import { searchCatalogItems } from "../../../utils/werkstattBedarfeApi";

/**
 * Find one Datanorm row and hand it back.
 *
 * Used in two places that need the same answer for the same reason: creating
 * a need, and re-linking one whose catalogue row a Datanorm re-import nulled.
 * That second case is not an edge — the FK is ON DELETE SET NULL, so every
 * refresh of the wholesaler's catalogue can silently make a row unorderable,
 * and this is the only way back.
 *
 * Search is server-side and debounced. The list is never filtered locally:
 * the pool is hundreds of thousands of rows and the page holds twenty.
 */
export interface KatalogArtikelSucheProps {
  token: string | null;
  language: Language;
  onPick: (item: MaterialCatalogItem) => void;
  /** Rendered above the field; the modal and the row menu word it differently. */
  label?: string;
  autoFocus?: boolean;
}

export function KatalogArtikelSuche({
  token,
  language,
  onPick,
  label,
  autoFocus = false,
}: KatalogArtikelSucheProps) {
  const de = language === "de";
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<MaterialCatalogItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const needle = query.trim();
    if (needle.length < 2) {
      setRows([]);
      setLoading(false);
      setFailed(false);
      return;
    }
    const timeout = window.setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setFailed(false);
      void searchCatalogItems(token, needle, controller.signal)
        .then((found) => {
          if (controller.signal.aborted) return;
          setRows(found);
        })
        .catch(() => {
          // A cancelled request is the normal case while typing, not a failure
          // worth a banner; anything else leaves the honest inline hint below.
          if (!controller.signal.aborted) setFailed(true);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 220);
    return () => window.clearTimeout(timeout);
  }, [query, token]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return (
    <div className="bedarfe-katalog-suche">
      <label className="bedarfe-field-label">
        {label ?? (de ? "Katalog-Artikel" : "Catalogue article")}
      </label>
      <input
        type="search"
        className="bedarfe-input"
        value={query}
        autoFocus={autoFocus}
        placeholder={de ? "Artikel oder Artikelnr. suchen…" : "Search article or number…"}
        onChange={(event) => setQuery(event.target.value)}
      />
      {loading && <p className="bedarfe-hint muted">{de ? "Suche läuft…" : "Searching…"}</p>}
      {failed && (
        <p className="bedarfe-hint bedarfe-hint--warn">
          {de
            ? "Katalog konnte nicht durchsucht werden."
            : "The catalogue could not be searched."}
        </p>
      )}
      {!loading && !failed && query.trim().length >= 2 && rows.length === 0 && (
        <p className="bedarfe-hint muted">
          {de ? "Kein Katalog-Artikel gefunden." : "No catalogue article found."}
        </p>
      )}
      {rows.length > 0 && (
        <ul className="bedarfe-katalog-treffer">
          {rows.map((row) => (
            <li key={`katalog-${row.id}`}>
              <button type="button" className="bedarfe-katalog-treffer-btn" onClick={() => onPick(row)}>
                <span className="bedarfe-katalog-treffer-name">{row.item_name}</span>
                <span className="bedarfe-katalog-treffer-meta muted">
                  {[
                    row.article_no ? `Art.-Nr. ${row.article_no}` : null,
                    row.manufacturer,
                    row.unit,
                  ]
                    .filter(Boolean)
                    .join(" · ") || (de ? "ohne Angaben" : "no details")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
