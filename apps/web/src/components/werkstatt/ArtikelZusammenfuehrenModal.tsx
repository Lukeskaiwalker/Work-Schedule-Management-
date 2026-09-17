/**
 * The confirmation in front of an irreversible merge.
 *
 * A merge moves a ledger, repoints machines and archives a row whose number is
 * printed on a shelf label. None of that can be undone from the app — the only
 * correction is merging back in the other direction, which keeps history but
 * not the numbering. So the dialog does the one thing a confirmation is for:
 * it says, in full and in German, exactly what is about to happen to each of
 * the two articles, and it names them by number so the person can check
 * against the stickers in front of them before pressing anything.
 *
 * Deliberately not a summary. "Fortfahren?" over a merge is how somebody loses
 * the wrong article number.
 */
import type { WerkstattDuplicateSide } from "../../types/werkstatt";

export interface ArtikelZusammenfuehrenModalProps {
  open: boolean;
  language: "de" | "en";
  /** The article that stays, with its number and its stock. */
  survivor: WerkstattDuplicateSide;
  /** The article that is folded in and archived. */
  duplicate: WerkstattDuplicateSide;
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onConfirm: () => void;
}

export function ArtikelZusammenfuehrenModal({
  open,
  language,
  survivor,
  duplicate,
  busy = false,
  error = null,
  onClose,
  onConfirm,
}: ArtikelZusammenfuehrenModalProps) {
  const de = language === "de";
  if (!open) return null;

  const title = de ? "Artikel zusammenführen" : "Merge articles";

  return (
    <div className="werkstatt-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="werkstatt-modal werkstatt-modal--narrow stock-merge"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="werkstatt-modal-head">
          <h2 className="werkstatt-modal-title">{title}</h2>
          <button
            type="button"
            className="werkstatt-modal-close"
            onClick={onClose}
            aria-label={de ? "Schließen" : "Close"}
          >
            ✕
          </button>
        </header>

        <div className="werkstatt-modal-body">
          <p className="stock-merge-lead">
            {de ? (
              <>
                <b>
                  {duplicate.article_number} „{duplicate.item_name}“
                </b>{" "}
                wird in{" "}
                <b>
                  {survivor.article_number} „{survivor.item_name}“
                </b>{" "}
                übernommen.
              </>
            ) : (
              <>
                <b>
                  {duplicate.article_number} “{duplicate.item_name}”
                </b>{" "}
                will be folded into{" "}
                <b>
                  {survivor.article_number} “{survivor.item_name}”
                </b>
                .
              </>
            )}
          </p>

          <ul className="stock-merge-facts">
            <li>
              {de
                ? "Übertragen werden: Bewegungen, Bestellpositionen, Kisten-Positionen, Maschinen, Inventurzählungen, Material-Zeilen und Lieferanten-Artikelnummern."
                : "Moved across: movements, order lines, crate positions, machines, stock-take counts, material lines and supplier article numbers."}
            </li>
            <li>
              {de
                ? `Hat ${survivor.article_number} bei einem Lieferanten schon eine Nummer, bleibt diese die Bestellnummer — die aus ${duplicate.article_number} wird beim selben Lieferanten-Eintrag vermerkt und geht nicht verloren.`
                : `Where ${survivor.article_number} already has a number with a supplier, that one stays the ordering number — ${duplicate.article_number}'s is recorded on the same supplier link rather than dropped.`}
            </li>
            <li>
              {de
                ? `Fehlende Angaben werden aus ${duplicate.article_number} ergänzt (EAN, Hersteller, Einheit, Kategorie, Lagerort, Bild).`
                : `Missing details are filled in from ${duplicate.article_number} (EAN, manufacturer, unit, category, location, image).`}
            </li>
            <li>
              {de
                ? `Der Bestand wird aus dem zusammengeführten Bewegungs-Journal neu berechnet — aktuell ${survivor.stock_total} + ${duplicate.stock_total}.`
                : `Stock is recomputed from the merged movement ledger — currently ${survivor.stock_total} + ${duplicate.stock_total}.`}
            </li>
            <li>
              {de
                ? `${duplicate.article_number} wird archiviert; sein Etikett führt künftig zu ${survivor.article_number}.`
                : `${duplicate.article_number} is archived; its label will from now on resolve to ${survivor.article_number}.`}
            </li>
            <li className="stock-merge-warning">
              {de
                ? "Das lässt sich nicht rückgängig machen."
                : "This cannot be undone."}
            </li>
          </ul>

          {error && (
            <p className="stock-modal-error" role="alert">
              {error}
            </p>
          )}
        </div>

        <footer className="werkstatt-modal-foot">
          <small className="muted" />
          <div className="werkstatt-modal-foot-actions">
            <button type="button" className="werkstatt-action-btn" onClick={onClose}>
              {de ? "Abbrechen" : "Cancel"}
            </button>
            <button
              type="button"
              className="werkstatt-action-btn werkstatt-action-btn--danger"
              disabled={busy}
              onClick={onConfirm}
            >
              {busy
                ? de
                  ? "Wird zusammengeführt…"
                  : "Merging…"
                : de
                  ? "Zusammenführen"
                  : "Merge"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
