/**
 * "Artikel bearbeiten" — fixing a stock article from the Bestand row.
 *
 * Until now a wrong name, a missing EAN or a shelf that moved could only be
 * corrected in the database, which in practice meant it was not corrected: the
 * workshop lived with "Schuko Steckdose weiss" next to "Schuko-Steckdose weiß"
 * until somebody merged them. The endpoints have always existed; what was
 * missing was a way in.
 *
 * Three rules shape the dialog:
 *
 * **It never writes a stock figure.** The counters are derived from the
 * movement ledger, so they are shown read-only with a link to the dialog that
 * can actually book one. A field here would be a number the server discards.
 *
 * **It only sends what changed.** A PATCH carrying every field would overwrite
 * a colleague's edit made while this was open (see `toUpdatePatch`).
 *
 * **It explains a machine instead of offering to unmake one.** `is_serialized`
 * is not editable: its units have their own labels, histories and inspection
 * dates, and unsetting it would orphan all of them.
 */
import { useCallback, useEffect, useState } from "react";

import { ApiError } from "../../api/client";
import type { WerkstattArticle, WerkstattCatalogGroup } from "../../types/werkstatt";
import {
  addArticleSupplierLink,
  archiveArticle,
  getArticle,
  linkArticleCatalog,
  refreshArticleImage,
  removeArticleSupplierLink,
  updateArticle,
  updateArticleSupplierLink,
} from "../../utils/werkstattArticlesApi";
import { searchWerkstattCatalog } from "../../utils/werkstattCatalogApi";
import { ArtikelFormFields } from "./ArtikelFormFields";
import {
  artikelFormError,
  artikelFormFromArticle,
  isEmptyPatch,
  toUpdatePatch,
  type ArtikelFormValues,
} from "./artikelForm";
import { useArtikelStammdaten } from "./useArtikelStammdaten";
import { useTaxonomieSchnellanlage } from "./useTaxonomieSchnellanlage";
import "../../styles/stock.css";

export interface ArtikelBearbeitenModalProps {
  open: boolean;
  articleId: number | null;
  language: "de" | "en";
  token: string | null;
  onClose: () => void;
  /** The saved row, so the list can be patched without a full reload. */
  onSaved: (article: WerkstattArticle) => void;
  onArchived: (article: WerkstattArticle) => void;
  onOpenStockDialog?: (articleId: number) => void;
  onOpenMachines?: () => void;
  /** Opened straight from the row's "Archivieren" entry: the dialog loads the
   *  article and shows the confirmation over it, so the sentence naming what
   *  is about to disappear is the same one in both routes. */
  startArchiveConfirm?: boolean;
}

export function ArtikelBearbeitenModal({
  open,
  articleId,
  language,
  token,
  onClose,
  onSaved,
  onArchived,
  onOpenStockDialog,
  onOpenMachines,
  startArchiveConfirm = false,
}: ArtikelBearbeitenModalProps) {
  const de = language === "de";
  const stammdaten = useArtikelStammdaten(token, open);

  const [article, setArticle] = useState<WerkstattArticle | null>(null);
  const [values, setValues] = useState<ArtikelFormValues | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  /* Linking a catalogue row is what gives an article a supplier's article
   * number, a picture that can be refreshed, and a place in the reorder flow.
   * Articles typed in by hand have none of that, and this is the only way to
   * give it to them after the fact. */
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogHits, setCatalogHits] = useState<WerkstattCatalogGroup[]>([]);
  /* A second supplier for the same article is the normal case, not an edge
   * one: the workshop buys the same terminal from two wholesalers and each
   * calls it something different. Without a way to add the second number
   * here, an order to that supplier resolves to nothing. */
  const [newSupplierId, setNewSupplierId] = useState<number | null>(null);
  const [newSupplierNo, setNewSupplierNo] = useState("");

  const taxonomy = useTaxonomieSchnellanlage({
    token,
    language,
    categories: stammdaten.categories,
    locations: stammdaten.locations,
    onCategoryCreated: (category) => {
      stammdaten.addCategory(category);
      setValues((prev) => (prev ? { ...prev, category_id: category.id } : prev));
    },
    onLocationCreated: (location) => {
      stammdaten.addLocation(location);
      setValues((prev) => (prev ? { ...prev, location_id: location.id } : prev));
    },
    onError: setError,
  });

  useEffect(() => {
    if (!open || articleId == null) {
      setArticle(null);
      setValues(null);
      setError(null);
      setConfirmArchive(false);
      return;
    }
    setConfirmArchive(startArchiveConfirm);
    let cancelled = false;
    setLoading(true);
    void getArticle(token, articleId)
      .then((row) => {
        if (cancelled) return;
        setArticle(row);
        setValues(artikelFormFromArticle(row));
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, articleId, token, startArchiveConfirm]);

  const save = useCallback(async () => {
    if (!article || !values || busy) return;
    const invalid = artikelFormError(values, de);
    if (invalid) {
      setError(invalid);
      return;
    }
    const patch = toUpdatePatch(values, article);
    if (isEmptyPatch(patch)) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await updateArticle(token, article.id, patch);
      onSaved(saved);
      onClose();
    } catch (err) {
      setError(detailOf(err, de));
    } finally {
      setBusy(false);
    }
  }, [article, values, busy, de, token, onSaved, onClose]);

  /** Reactivate AND save whatever is in the form, in one PATCH.
   *
   * The button used to send `{is_archived: false}` alone while the hint above
   * it said "Speichern mit „Reaktivieren“ bringt ihn zurück in die Liste" —
   * so a corrected EAN and a changed unit were silently dropped, and the page
   * then announced "SP-0042 gespeichert" over the loss. One request, because
   * two would leave the row half-saved if the second failed.
   */
  const reactivate = useCallback(async () => {
    if (!article || !values || busy) return;
    const invalid = artikelFormError(values, de);
    if (invalid) {
      setError(invalid);
      return;
    }
    const patch = { ...toUpdatePatch(values, article), is_archived: false };
    setBusy(true);
    setError(null);
    try {
      const revived = await updateArticle(token, article.id, patch);
      setArticle(revived);
      setValues(artikelFormFromArticle(revived));
      onSaved(revived);
    } catch (err) {
      setError(detailOf(err, de));
    } finally {
      setBusy(false);
    }
  }, [article, values, busy, de, token, onSaved]);

  const archive = useCallback(async () => {
    if (!article || busy) return;
    setBusy(true);
    setError(null);
    try {
      onArchived(await archiveArticle(token, article.id));
      onClose();
    } catch (err) {
      setError(detailOf(err, de));
    } finally {
      setBusy(false);
    }
  }, [article, busy, token, onArchived, onClose, de]);

  const refreshImage = useCallback(async () => {
    if (!article || busy) return;
    setBusy(true);
    try {
      const refreshed = await refreshArticleImage(token, article.id);
      setArticle(refreshed);
      setValues((prev) => (prev ? { ...prev, image_url: refreshed.image_url } : prev));
    } catch (err) {
      setError(detailOf(err, de));
    } finally {
      setBusy(false);
    }
  }, [article, busy, token, de]);

  const searchCatalog = useCallback(
    async (query: string) => {
      setCatalogQuery(query);
      if (query.trim().length < 2) {
        setCatalogHits([]);
        return;
      }
      try {
        setCatalogHits(await searchWerkstattCatalog(token, { q: query.trim(), limit: 8 }));
      } catch {
        // Linking is an extra, never a precondition for saving a name.
        setCatalogHits([]);
      }
    },
    [token],
  );

  const linkCatalog = useCallback(
    async (catalogItemId: number) => {
      if (!article || busy) return;
      setBusy(true);
      try {
        const linked = await linkArticleCatalog(token, article.id, catalogItemId);
        setArticle(linked);
        /* Merge, do not reseed. Re-running `artikelFormFromArticle` replaced
         * the form with the server's row — so a corrected Bezeichnung and
         * Einheit typed a minute earlier vanished with no message, and
         * "Speichern" then sent an empty patch and closed as if it had saved
         * them. Only what the LINK actually changed is taken over; every
         * field the person has been editing stays theirs. */
        setValues((prev) =>
          prev === null
            ? artikelFormFromArticle(linked)
            : {
                ...prev,
                image_url: prev.image_url ?? linked.image_url,
                supplier_id: prev.supplier_id ?? preferredSupplierId(linked),
                supplier_article_no:
                  prev.supplier_article_no.trim() || preferredSupplierNo(linked),
              },
        );
        setCatalogQuery("");
        setCatalogHits([]);
      } catch (err) {
        setError(detailOf(err, de));
      } finally {
        setBusy(false);
      }
    },
    [article, busy, token, de],
  );

  /** Reload the article after any supplier-link write; the server decides
   *  which link is preferred and what the list now looks like. */
  const refetch = useCallback(async () => {
    if (!article) return;
    setArticle(await getArticle(token, article.id));
  }, [article, token]);

  const addSupplier = useCallback(async () => {
    if (!article || busy || newSupplierId == null) return;
    setBusy(true);
    try {
      await addArticleSupplierLink(token, article.id, {
        supplier_id: newSupplierId,
        supplier_article_no: newSupplierNo.trim() || null,
        // The first link on an article with none has to be preferred, or
        // every reorder flow has no supplier to target.
        is_preferred: article.suppliers.length === 0,
      });
      setNewSupplierId(null);
      setNewSupplierNo("");
      await refetch();
    } catch (err) {
      setError(detailOf(err, de));
    } finally {
      setBusy(false);
    }
  }, [article, busy, newSupplierId, newSupplierNo, token, refetch, de]);

  const preferSupplier = useCallback(
    async (linkId: number) => {
      if (!article || busy) return;
      setBusy(true);
      try {
        // The server clears the flag on the article's other links itself.
        await updateArticleSupplierLink(token, article.id, linkId, { is_preferred: true });
        await refetch();
      } catch (err) {
        setError(detailOf(err, de));
      } finally {
        setBusy(false);
      }
    },
    [article, busy, token, refetch, de],
  );

  const dropSupplier = useCallback(
    async (linkId: number) => {
      if (!article || busy) return;
      setBusy(true);
      try {
        await removeArticleSupplierLink(token, article.id, linkId);
        const refreshed = await getArticle(token, article.id);
        setArticle(refreshed);
      } catch (err) {
        setError(detailOf(err, de));
      } finally {
        setBusy(false);
      }
    },
    [article, busy, token, de],
  );

  if (!open) return null;

  const title = de ? "Artikel bearbeiten" : "Edit article";

  return (
    <div className="werkstatt-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="werkstatt-modal werkstatt-modal--wide stock-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="werkstatt-modal-head">
          <div>
            <span className="werkstatt-sub-breadcrumb">
              {de ? "WERKSTATT · ARTIKEL" : "WORKSHOP · ITEM"}
            </span>
            <h2 className="werkstatt-modal-title">
              {article ? `${article.article_number} · ${article.item_name}` : title}
            </h2>
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

        <div className="werkstatt-modal-body">
          {loading && <p className="muted">{de ? "Artikel wird geladen…" : "Loading article…"}</p>}

          {article?.is_serialized && (
            <div className="stock-lookup stock-lookup--machine" role="note">
              <span className="stock-lookup-badge">
                {de ? "Einzelexemplare (Maschine)" : "Individual units (machine)"}
              </span>
              <p className="stock-lookup-note muted">
                {de
                  ? "Zu diesem Artikel gehören einzeln etikettierte Maschinen mit eigenen Prüfterminen. Menge, Ausgabe und Prüfung laufen über den Maschinen-Tab."
                  : "This article has individually labelled machines with their own inspection dates. Quantity, checkout and inspection happen in the Machines tab."}
              </p>
              {onOpenMachines && (
                <button type="button" className="werkstatt-card-action" onClick={onOpenMachines}>
                  {de ? "Zu den Maschinen" : "Go to machines"}
                </button>
              )}
            </div>
          )}

          {article?.is_archived && (
            <p className="stock-modal-error" role="status">
              {de
                ? "Dieser Artikel ist archiviert. „Reaktivieren“ speichert die Änderungen und holt ihn zurück in die Liste."
                : "This article is archived. “Reactivate” saves your changes and brings it back to the list."}
            </p>
          )}

          {article && values && (
            <ArtikelFormFields
              de={de}
              values={values}
              onChange={setValues}
              categories={stammdaten.categories}
              locations={stammdaten.locations}
              suppliers={stammdaten.suppliers}
              mode="edit"
              disabled={busy}
              onCreateCategory={taxonomy.openCategory}
              onCreateLocation={taxonomy.openLocation}
              stock={{
                total: article.stock_total,
                available: article.stock_available,
                unit: article.unit,
              }}
              onOpenStockDialog={
                onOpenStockDialog ? () => onOpenStockDialog(article.id) : undefined
              }
            />
          )}

          {article && article.suppliers.length > 0 && (
            <div className="stock-suppliers">
              <span className="werkstatt-field-label">
                {de ? "Verknüpfte Lieferanten" : "Linked suppliers"}
              </span>
              <ul className="stock-suppliers-list">
                {article.suppliers.map((link) => (
                  <li key={link.id}>
                    <b>{link.supplier_name}</b>
                    <span className="muted">
                      {link.supplier_article_no || (de ? "keine Art.-Nr." : "no article no.")}
                    </span>
                    {link.is_preferred ? (
                      <span className="werkstatt-katalog-preferred">
                        {de ? "bevorzugt" : "preferred"}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="werkstatt-card-action"
                        disabled={busy}
                        onClick={() => void preferSupplier(link.id)}
                      >
                        {de ? "Bevorzugen" : "Prefer"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="werkstatt-card-action"
                      disabled={busy}
                      onClick={() => void dropSupplier(link.id)}
                    >
                      {de ? "Entfernen" : "Remove"}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {article && stammdaten.suppliers.length > 0 && (
            <div className="stock-form-row stock-supplier-add">
              <label className="werkstatt-field werkstatt-field--grow">
                <span className="werkstatt-field-label">
                  {de ? "Lieferant hinzufügen" : "Add a supplier"}
                </span>
                <select
                  className="werkstatt-field-select"
                  value={newSupplierId == null ? "" : String(newSupplierId)}
                  disabled={busy}
                  onChange={(event) =>
                    setNewSupplierId(event.target.value ? Number(event.target.value) : null)
                  }
                >
                  <option value="">{de ? "— wählen —" : "— pick one —"}</option>
                  {stammdaten.suppliers
                    .filter(
                      (supplier) =>
                        !article.suppliers.some((link) => link.supplier_id === supplier.id),
                    )
                    .map((supplier) => (
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
                  value={newSupplierNo}
                  disabled={busy || newSupplierId == null}
                  onChange={(event) => setNewSupplierNo(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="werkstatt-action-btn"
                disabled={busy || newSupplierId == null}
                onClick={() => void addSupplier()}
              >
                {de ? "Hinzufügen" : "Add"}
              </button>
            </div>
          )}

          {article && (
            <div className="stock-catalog-link">
              <span className="werkstatt-field-label">
                {article.source_catalog_item_id != null
                  ? de
                    ? "Katalog-Verknüpfung ändern"
                    : "Change catalogue link"
                  : de
                    ? "Katalog verknüpfen"
                    : "Link a catalogue row"}
              </span>
              <input
                type="text"
                className="werkstatt-field-input"
                value={catalogQuery}
                disabled={busy}
                placeholder={
                  de
                    ? "Im Lieferantenkatalog suchen…"
                    : "Search the supplier catalogue…"
                }
                onChange={(event) => void searchCatalog(event.target.value)}
              />
              {catalogHits.length > 0 && (
                <ul className="stock-catalog-hits">
                  {catalogHits.map((group) => (
                    <li key={group.hero.id}>
                      <span>
                        <b>{group.hero.item_name}</b>
                        <small className="muted">
                          {group.hero.supplier_name ?? "—"} ·{" "}
                          {group.hero.article_no || (de ? "keine Art.-Nr." : "no article no.")}
                        </small>
                      </span>
                      <button
                        type="button"
                        className="werkstatt-card-action"
                        disabled={busy}
                        onClick={() => void linkCatalog(group.hero.id)}
                      >
                        {de ? "Verknüpfen" : "Link"}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {error && (
            <p className="stock-modal-error" role="alert">
              {error}
            </p>
          )}
        </div>

        <footer className="werkstatt-modal-foot">
          <div className="werkstatt-modal-foot-actions">
            {article?.source_catalog_item_id != null && (
              <button
                type="button"
                className="werkstatt-action-btn"
                disabled={busy}
                onClick={() => void refreshImage()}
              >
                {de ? "Bild aktualisieren" : "Refresh image"}
              </button>
            )}
            {article && !article.is_archived && (
              <button
                type="button"
                className="werkstatt-action-btn"
                disabled={busy}
                onClick={() => setConfirmArchive(true)}
              >
                {de ? "Archivieren" : "Archive"}
              </button>
            )}
          </div>
          <div className="werkstatt-modal-foot-actions">
            <button type="button" className="werkstatt-action-btn" onClick={onClose}>
              {de ? "Abbrechen" : "Cancel"}
            </button>
            {article?.is_archived ? (
              <button
                type="button"
                className="werkstatt-action-btn werkstatt-action-btn--primary"
                disabled={busy}
                onClick={() => void reactivate()}
              >
                {busy
                  ? de
                    ? "Speichern…"
                    : "Saving…"
                  : de
                    ? "Reaktivieren"
                    : "Reactivate"}
              </button>
            ) : (
              <button
                type="button"
                className="werkstatt-action-btn werkstatt-action-btn--primary"
                disabled={busy || !article}
                onClick={() => void save()}
              >
                {busy ? (de ? "Speichern…" : "Saving…") : de ? "Speichern" : "Save"}
              </button>
            )}
          </div>
        </footer>

        {confirmArchive && article && (
          <div className="werkstatt-confirm" role="alertdialog" aria-label={de ? "Archivieren" : "Archive"}>
            <p>
              {de
                ? `„${article.item_name}“ wird archiviert und verschwindet aus dem Bestand. Bewegungen und Bestellungen bleiben erhalten; der Artikel lässt sich später wieder reaktivieren.`
                : `“${article.item_name}” will be archived and leave the stock list. Movements and orders are kept; it can be reactivated later.`}
            </p>
            <div className="werkstatt-modal-foot-actions">
              <button
                type="button"
                className="werkstatt-action-btn"
                onClick={() => setConfirmArchive(false)}
              >
                {de ? "Abbrechen" : "Cancel"}
              </button>
              <button
                type="button"
                className="werkstatt-action-btn werkstatt-action-btn--danger"
                disabled={busy}
                onClick={() => void archive()}
              >
                {de ? "Archivieren" : "Archive"}
              </button>
            </div>
          </div>
        )}
        {taxonomy.modals}
      </div>
    </div>
  );
}

/** The supplier a freshly linked article would order from, if any. */
function preferredSupplierId(article: WerkstattArticle): number | null {
  const link = article.suppliers.find((row) => row.is_preferred) ?? article.suppliers[0];
  return link?.supplier_id ?? null;
}

function preferredSupplierNo(article: WerkstattArticle): string {
  const link = article.suppliers.find((row) => row.is_preferred) ?? article.suppliers[0];
  return link?.supplier_article_no ?? "";
}

function detailOf(err: unknown, de: boolean): string {
  if (err instanceof ApiError && typeof err.detail === "string") return err.detail;
  if (err instanceof Error && err.message) return err.message;
  return de ? "Speichern fehlgeschlagen." : "Saving failed.";
}
