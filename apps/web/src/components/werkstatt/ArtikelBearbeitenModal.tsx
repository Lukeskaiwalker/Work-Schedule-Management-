/**
 * "Artikel bearbeiten" — fixing a stock article from the Bestand row.
 *
 * Until now a wrong name, a missing EAN or a shelf that moved could only be
 * corrected in the database, which in practice meant it was not corrected: the
 * workshop lived with "Schuko Steckdose weiss" next to "Schuko-Steckdose weiß"
 * until somebody merged them. The endpoints have always existed; what was
 * missing was a way in.
 *
 * Four rules shape the dialog:
 *
 * **It never writes a stock figure.** The counters are derived from the
 * movement ledger. The "Bestand" section books MOVEMENTS — a counted stock, a
 * Wareneingang — through the same endpoint as "Bestand anpassen", and shows
 * the row the server answers with (see ArtikelBestandAbschnitt).
 *
 * **It only sends what changed.** A PATCH carrying every field would overwrite
 * a colleague's edit made while this was open (see `toUpdatePatch`). Supplier
 * numbers live on the supplier LINK, so they are PATCHed there
 * (see artikelLieferanten.ts).
 *
 * **It never drops a change silently.** "Speichern" writes everything the
 * form shows as changed — article fields, link numbers, a picked supplier —
 * and closing over unsaved changes asks first. It used to close on an empty
 * article patch while a corrected supplier number sat in the form.
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
  type WerkstattArticleStockSnapshot,
} from "../../utils/werkstattArticlesApi";
import { searchWerkstattCatalog } from "../../utils/werkstattCatalogApi";
import { ArtikelBestandAbschnitt } from "./ArtikelBestandAbschnitt";
import { ArtikelFormFields } from "./ArtikelFormFields";
import { ArtikelLieferantenAbschnitt } from "./ArtikelLieferantenAbschnitt";
import {
  artikelFormError,
  artikelFormFromArticle,
  isEmptyPatch,
  toUpdatePatch,
  type ArtikelFormValues,
} from "./artikelForm";
import {
  EMPTY_NEW_LINK,
  changedLinkNumbers,
  pendingNewLink,
  withLinkDraft,
  type LinkDrafts,
  type NewLinkDraft,
} from "./artikelLieferanten";
import { useArtikelStammdaten } from "./useArtikelStammdaten";
import { useTaxonomieSchnellanlage } from "./useTaxonomieSchnellanlage";
import "../../styles/stock.css";
import "../../styles/stock-edit.css";

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
  /** A booking from the Bestand section — the endpoint's row, so the list
   *  behind the dialog can show the same figures without a refetch. */
  onStockChanged?: (snapshot: WerkstattArticleStockSnapshot) => void;
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
  onStockChanged,
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
  /* Supplier numbers as typed, per link, and a supplier picked under
   * "Lieferant hinzufügen" — both written by "Speichern". */
  const [linkDrafts, setLinkDrafts] = useState<LinkDrafts>({});
  const [newLink, setNewLink] = useState<NewLinkDraft>(EMPTY_NEW_LINK);
  /* A figure typed in the Bestand section and not booked yet. */
  const [stockPending, setStockPending] = useState(false);
  /* What to do once "Verwerfen" is confirmed — close, or hand over to the
   * stock dialog — or null while nothing is being thrown away. */
  const [discardThen, setDiscardThen] = useState<(() => void) | null>(null);

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
      setLinkDrafts({});
      setNewLink(EMPTY_NEW_LINK);
      setStockPending(false);
      setDiscardThen(null);
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

  /* Everything the form shows as changed, computed per render: what Save
   * writes, and what closing would throw away. */
  const articlePatch = article && values ? toUpdatePatch(values, article) : {};
  const linkChanges = article ? changedLinkNumbers(article, linkDrafts) : [];
  const linkToAdd = article ? pendingNewLink(article, newLink) : null;
  const dirty =
    !isEmptyPatch(articlePatch) || linkChanges.length > 0 || linkToAdd !== null || stockPending;

  const save = useCallback(async () => {
    if (!article || !values || busy) return;
    if (stockPending) {
      // Booking stock is its own, deliberate step; closing over a typed but
      // unbooked count would lose it without a word.
      setError(
        de
          ? "Im Bestand steht noch eine Eingabe, die nicht gebucht ist — „Zählung buchen“ bzw. „Wareneingang buchen“ drücken oder das Feld leeren."
          : "The stock section holds an entry that has not been booked — press “Book count” / “Book receipt” or clear the field.",
      );
      return;
    }
    const invalid = artikelFormError(values, de);
    if (invalid) {
      setError(invalid);
      return;
    }
    if (isEmptyPatch(articlePatch) && linkChanges.length === 0 && linkToAdd === null) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let current = article;
      if (!isEmptyPatch(articlePatch)) {
        current = await updateArticle(token, article.id, articlePatch);
        setArticle(current);
      }
      for (const change of linkChanges) {
        await updateArticleSupplierLink(token, article.id, change.linkId, {
          supplier_article_no: change.supplier_article_no,
        });
      }
      if (linkToAdd) await addArticleSupplierLink(token, article.id, linkToAdd);
      if (linkChanges.length > 0 || linkToAdd) {
        // The server decides which link is preferred and how a number is
        // stored; the list is told what it now holds.
        current = await getArticle(token, article.id);
      }
      onSaved(current);
      onClose();
    } catch (err) {
      setError(detailOf(err, de));
      // Some writes may have landed. Showing the server's row makes the
      // remaining difference — what is still unsaved — the part still marked.
      const fresh = await getArticle(token, article.id).catch(() => null);
      if (fresh) setArticle(fresh);
    } finally {
      setBusy(false);
    }
  }, [
    article,
    values,
    busy,
    stockPending,
    articlePatch,
    linkChanges,
    linkToAdd,
    de,
    token,
    onSaved,
    onClose,
  ]);

  /** Close, or hand over to another dialog — but ask first when the form
   *  holds changes that would be lost. */
  const leave = useCallback(
    (then: () => void) => {
      if (busy) return;
      if (dirty) {
        setDiscardThen(() => then);
        return;
      }
      then();
    },
    [busy, dirty],
  );

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
          prev === null ? artikelFormFromArticle(linked) : withLinkFills(prev, article, linked),
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
    if (!article || busy) return;
    const payload = pendingNewLink(article, newLink);
    if (!payload) return;
    setBusy(true);
    try {
      await addArticleSupplierLink(token, article.id, payload);
      setNewLink(EMPTY_NEW_LINK);
      await refetch();
    } catch (err) {
      setError(detailOf(err, de));
    } finally {
      setBusy(false);
    }
  }, [article, busy, newLink, token, refetch, de]);

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

  /** A booking from the Bestand section: the endpoint's row, folded in. */
  const applyBooking = useCallback(
    (snapshot: WerkstattArticleStockSnapshot) => {
      setArticle((prev) =>
        prev && prev.id === snapshot.id
          ? {
              ...prev,
              stock_total: snapshot.stock_total,
              stock_available: snapshot.stock_available,
              stock_status: snapshot.stock_status,
            }
          : prev,
      );
      onStockChanged?.(snapshot);
    },
    [onStockChanged],
  );

  /** After a 409 from the Bestand section: the figures on screen are stale. */
  const refreshCounters = useCallback(async () => {
    if (!article) return;
    const fresh = await getArticle(token, article.id).catch(() => null);
    if (!fresh) return;
    // Counters only: the master-data fields may hold the person's edits, and
    // their patch is computed against the row they were seeded from.
    setArticle((prev) =>
      prev && prev.id === fresh.id
        ? {
            ...prev,
            stock_total: fresh.stock_total,
            stock_available: fresh.stock_available,
            stock_out: fresh.stock_out,
            stock_repair: fresh.stock_repair,
            stock_status: fresh.stock_status,
          }
        : prev,
    );
    onStockChanged?.({
      id: fresh.id,
      stock_total: fresh.stock_total,
      stock_available: fresh.stock_available,
      stock_status: fresh.stock_status,
    });
  }, [article, token, onStockChanged]);

  if (!open) return null;

  const title = de ? "Artikel bearbeiten" : "Edit article";
  const close = () => leave(onClose);

  return (
    <div className="werkstatt-modal-backdrop" role="presentation" onClick={close}>
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
            onClick={close}
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
            />
          )}

          {/* A machine type's quantity is its units; those are booked in the
              Maschinen tab, as the note above says. */}
          {article && !article.is_serialized && (
            <ArtikelBestandAbschnitt
              de={de}
              token={token}
              article={article}
              disabled={busy}
              onBooked={applyBooking}
              onStale={refreshCounters}
              onPendingChange={setStockPending}
              onOpenStockDialog={
                onOpenStockDialog
                  ? () => leave(() => onOpenStockDialog(article.id))
                  : undefined
              }
            />
          )}

          {article && (
            <ArtikelLieferantenAbschnitt
              de={de}
              article={article}
              suppliers={stammdaten.suppliers}
              drafts={linkDrafts}
              onDraft={(linkId, value) => setLinkDrafts((prev) => withLinkDraft(prev, linkId, value))}
              newLink={newLink}
              onNewLink={setNewLink}
              busy={busy}
              onPrefer={(linkId) => void preferSupplier(linkId)}
              onRemove={(linkId) => void dropSupplier(linkId)}
              onAdd={() => void addSupplier()}
            />
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
            <button type="button" className="werkstatt-action-btn" onClick={close}>
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
        {discardThen && (
          <div
            className="werkstatt-confirm"
            role="alertdialog"
            aria-label={de ? "Änderungen verwerfen?" : "Discard changes?"}
          >
            <p>
              {de
                ? "Es gibt ungespeicherte Änderungen. Verwerfen und schließen?"
                : "There are unsaved changes. Discard them and close?"}
            </p>
            <div className="werkstatt-modal-foot-actions">
              <button
                type="button"
                className="werkstatt-action-btn"
                onClick={() => setDiscardThen(null)}
              >
                {de ? "Weiter bearbeiten" : "Keep editing"}
              </button>
              <button
                type="button"
                className="werkstatt-action-btn werkstatt-action-btn--danger"
                onClick={() => {
                  const then = discardThen;
                  setDiscardThen(null);
                  then();
                }}
              >
                {de ? "Verwerfen" : "Discard"}
              </button>
            </div>
          </div>
        )}
        {taxonomy.modals}
      </div>
    </div>
  );
}

/**
 * The form after "Katalog verknüpfen": the fields the link may fill on the
 * server — EAN, Hersteller, Einheit, picture, each only where the article had
 * none — are taken from the linked row wherever the person left them as they
 * were. Taking the picture alone kept "" for the other three while the row now
 * held them, so Save PATCHed them back to null and wiped the EAN the link had
 * just set. A field the person typed in or cleared stays as they left it.
 */
function withLinkFills(
  values: ArtikelFormValues,
  before: WerkstattArticle,
  linked: WerkstattArticle,
): ArtikelFormValues {
  const was = artikelFormFromArticle(before);
  const now = artikelFormFromArticle(linked);
  const untouched = (field: "ean" | "manufacturer" | "unit") =>
    values[field].trim() === was[field].trim();
  return {
    ...values,
    ean: untouched("ean") ? now.ean : values.ean,
    manufacturer: untouched("manufacturer") ? now.manufacturer : values.manufacturer,
    unit: untouched("unit") ? now.unit : values.unit,
    image_url: values.image_url === was.image_url ? now.image_url : values.image_url,
  };
}

function detailOf(err: unknown, de: boolean): string {
  if (err instanceof ApiError && typeof err.detail === "string") return err.detail;
  if (err instanceof Error && err.message) return err.message;
  return de ? "Speichern fehlgeschlagen." : "Saving failed.";
}
