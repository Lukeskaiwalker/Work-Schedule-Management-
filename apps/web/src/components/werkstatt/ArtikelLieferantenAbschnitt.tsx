/**
 * "Lieferanten" in the edit dialog: every linked supplier with its article
 * number as an editable field, plus "Lieferant hinzufügen".
 *
 * Presentational. The drafts belong to the dialog, because the dialog's
 * "Speichern" is what writes them (see artikelLieferanten.ts) — a number typed
 * here and then "saved" must reach the server, not vanish with the dialog.
 * "Bevorzugen", "Entfernen" and "Hinzufügen" act at once, as they always did.
 */
import type { WerkstattArticle, WerkstattSupplier } from "../../types/werkstatt";
import { linkNumberValue, type LinkDrafts, type NewLinkDraft } from "./artikelLieferanten";

export interface ArtikelLieferantenAbschnittProps {
  de: boolean;
  article: Pick<WerkstattArticle, "suppliers">;
  suppliers: ReadonlyArray<WerkstattSupplier>;
  drafts: LinkDrafts;
  onDraft: (linkId: number, value: string) => void;
  newLink: NewLinkDraft;
  onNewLink: (next: NewLinkDraft) => void;
  busy: boolean;
  onPrefer: (linkId: number) => void;
  onRemove: (linkId: number) => void;
  onAdd: () => void;
}

export function ArtikelLieferantenAbschnitt({
  de,
  article,
  suppliers,
  drafts,
  onDraft,
  newLink,
  onNewLink,
  busy,
  onPrefer,
  onRemove,
  onAdd,
}: ArtikelLieferantenAbschnittProps) {
  const addable = suppliers.filter(
    (supplier) => !article.suppliers.some((link) => link.supplier_id === supplier.id),
  );

  return (
    <div className="stock-suppliers">
      <span className="werkstatt-field-label">
        {de ? "Lieferanten" : "Suppliers"}
      </span>
      {article.suppliers.length === 0 && (
        <p className="muted stock-suppliers-empty">
          {de
            ? "Noch kein Lieferant verknüpft — ohne Lieferanten-Nr. findet weder Suche noch Scan den Artikel darüber."
            : "No supplier linked yet — without a supplier number neither search nor scan can find it that way."}
        </p>
      )}
      {article.suppliers.length > 0 && (
        <ul className="stock-suppliers-list">
          {article.suppliers.map((link) => (
            <li key={link.id} className="stock-supplier-row">
              <b className="stock-supplier-name">{link.supplier_name}</b>
              <input
                type="text"
                className="werkstatt-field-input stock-supplier-no"
                value={linkNumberValue(drafts, link)}
                disabled={busy}
                placeholder={de ? "Art.-Nr. des Lieferanten" : "Supplier's article no."}
                aria-label={
                  de
                    ? `Lieferanten-Art.-Nr. bei ${link.supplier_name}`
                    : `Supplier article no. at ${link.supplier_name}`
                }
                onChange={(event) => onDraft(link.id, event.target.value)}
              />
              {link.is_preferred ? (
                <span className="werkstatt-katalog-preferred">
                  {de ? "bevorzugt" : "preferred"}
                </span>
              ) : (
                <button
                  type="button"
                  className="werkstatt-card-action"
                  disabled={busy}
                  onClick={() => onPrefer(link.id)}
                >
                  {de ? "Bevorzugen" : "Prefer"}
                </button>
              )}
              <button
                type="button"
                className="werkstatt-card-action"
                disabled={busy}
                onClick={() => onRemove(link.id)}
              >
                {de ? "Entfernen" : "Remove"}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* A second supplier for the same article is the normal case, not an
          edge one: the workshop buys the same terminal from two wholesalers
          and each calls it something different. */}
      {addable.length > 0 && (
        <div className="stock-form-row stock-supplier-add">
          <label className="werkstatt-field werkstatt-field--grow">
            <span className="werkstatt-field-label">
              {de ? "Lieferant hinzufügen" : "Add a supplier"}
            </span>
            <select
              className="werkstatt-field-select"
              value={newLink.supplierId == null ? "" : String(newLink.supplierId)}
              disabled={busy}
              onChange={(event) =>
                onNewLink({
                  ...newLink,
                  supplierId: event.target.value ? Number(event.target.value) : null,
                })
              }
            >
              <option value="">{de ? "— wählen —" : "— pick one —"}</option>
              {addable.map((supplier) => (
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
              value={newLink.number}
              disabled={busy || newLink.supplierId == null}
              aria-label={
                de
                  ? "Lieferanten-Art.-Nr. für den neuen Lieferanten"
                  : "Supplier article no. for the new supplier"
              }
              onChange={(event) => onNewLink({ ...newLink, number: event.target.value })}
            />
          </label>
          <button
            type="button"
            className="werkstatt-action-btn"
            disabled={busy || newLink.supplierId == null}
            onClick={onAdd}
          >
            {de ? "Hinzufügen" : "Add"}
          </button>
        </div>
      )}
    </div>
  );
}
