import type { Language, MaterialCatalogItem } from "../../../types";
import type { MaterialNeedRow } from "../../../types/materialNeeds";
import { KatalogArtikelSuche } from "./KatalogArtikelSuche";

/**
 * Re-link one need to a catalogue article — the recovery path.
 *
 * `material_catalog_item_id` is ON DELETE SET NULL, so every Datanorm
 * re-import can silently unlink rows that were orderable yesterday. The row
 * keeps its article number as a hint; this is how it gets its link back. It
 * also unlinks, for the case where the wrong article was matched.
 */
export interface KatalogZuordnenModalProps {
  row: MaterialNeedRow | null;
  language: Language;
  token: string | null;
  busy: boolean;
  onPick: (row: MaterialNeedRow, item: MaterialCatalogItem) => void;
  onUnlink: (row: MaterialNeedRow) => void;
  onClose: () => void;
}

export function KatalogZuordnenModal({
  row,
  language,
  token,
  busy,
  onPick,
  onUnlink,
  onClose,
}: KatalogZuordnenModalProps) {
  const de = language === "de";
  if (row == null) return null;

  return (
    <div className="werkstatt-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="werkstatt-modal werkstatt-modal--narrow"
        role="dialog"
        aria-modal="true"
        aria-label={de ? "Katalog-Artikel zuordnen" : "Link catalogue article"}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="werkstatt-modal-head">
          <div>
            <span className="werkstatt-sub-breadcrumb">
              {de ? "PROJEKT-BEDARFE › ZUORDNEN" : "PROJECT NEEDS › LINK"}
            </span>
            <h2 className="werkstatt-modal-title">{row.item}</h2>
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

        <div className="werkstatt-modal-body bedarfe-neu-body">
          {row.article_no && (
            <p className="bedarfe-hint muted">
              {de ? "Notierte Artikelnr.: " : "Noted article no.: "}
              {row.article_no}
            </p>
          )}
          <KatalogArtikelSuche
            token={token}
            language={language}
            autoFocus
            onPick={(item) => onPick(row, item)}
            label={de ? "Passenden Katalog-Artikel suchen" : "Find the matching catalogue article"}
          />
        </div>

        <footer className="werkstatt-modal-foot">
          <button type="button" className="werkstatt-action-btn" onClick={onClose}>
            {de ? "Abbrechen" : "Cancel"}
          </button>
          {row.material_catalog_item_id != null && (
            <button
              type="button"
              className="werkstatt-action-btn werkstatt-action-btn--warn"
              disabled={busy}
              onClick={() => onUnlink(row)}
            >
              {de ? "Zuordnung entfernen" : "Remove link"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
