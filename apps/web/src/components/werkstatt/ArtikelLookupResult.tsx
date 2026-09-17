/**
 * Step 2 of "Neuer Lagerartikel": what the code turned out to be.
 *
 * The four outcomes need four different screens, and flattening them into one
 * "here is a form, some fields may be filled in" is how people end up creating
 * a second row for something that is already on the shelf. So:
 *
 *   existing → NOT a form. A card naming the article, with the action that is
 *              actually wanted ("Bestand anpassen") and no way to create a
 *              duplicate from here.
 *   catalog  → the picker, because the wholesaler's row is a better identity
 *              than anything typed, and it brings their article number along.
 *   external → the form, prefilled, behind a banner that says where the words
 *              came from and links to the page, because a scrape is a guess.
 *   none     → the form, empty, with a sentence saying why nothing was found.
 *
 * The form itself lives in ArtikelFormFields and is rendered by the host; this
 * component is the part above it.
 */
import type { WerkstattArticleLookup } from "../../types/werkstatt";
import { lookupDetail, lookupHeadline } from "../../utils/werkstattArticleLookupApi";
import { unitLabel } from "./unitLabel";

export interface ArtikelLookupResultProps {
  de: boolean;
  result: WerkstattArticleLookup;
  /** Offered on an `existing` hit — the thing somebody actually wants. */
  onAdjustStock?: (articleId: number) => void;
  onEditArticle?: (articleId: number) => void;
  onBack: () => void;
}

export function ArtikelLookupResult({
  de,
  result,
  onAdjustStock,
  onEditArticle,
  onBack,
}: ArtikelLookupResultProps) {
  if (result.kind === "existing") {
    const article = result.article;
    const unit = unitLabel(article.unit, de);
    /* Two hits that are "already in stock" and yet must not offer the same
     * button. A MACHINE type is counted one labelled unit at a time in the
     * Maschinen tab, so a stock dialog for it would write a figure nothing
     * reads. An ARCHIVED row is not in the list at all, so a dialog opened on
     * it books onto something that has been taken out of service — and the
     * card used to say "Bereits im Bestand" about it without a word. */
    const isMachine = Boolean(article.is_serialized);
    const isArchived = Boolean(article.is_archived);
    const offerStock = Boolean(onAdjustStock) && !isMachine && !isArchived;
    return (
      <div className="stock-lookup stock-lookup--existing" role="status">
        <div className="stock-lookup-head">
          <span className="stock-lookup-badge stock-lookup-badge--existing">
            {lookupHeadline(result, de)}
          </span>
          {result.machine_number && (
            <span className="stock-lookup-sub">
              {de ? "Maschine " : "Machine "}
              {result.machine_number}
            </span>
          )}
          {isArchived && (
            <span className="stock-lookup-sub stock-lookup-sub--archived">
              {de ? "archiviert" : "archived"}
            </span>
          )}
        </div>
        <p className="stock-lookup-line">
          <b>{article.article_number}</b> · {article.item_name} ·{" "}
          {article.stock_available} / {article.stock_total} {unit}
        </p>
        {result.via_merged_article_number && (
          <p className="stock-lookup-note muted">
            {de
              ? `Das Etikett ${result.via_merged_article_number} wurde nach ${article.article_number} zusammengeführt.`
              : `Label ${result.via_merged_article_number} was merged into ${article.article_number}.`}
          </p>
        )}
        {isMachine && (
          <p className="stock-lookup-note muted">
            {de
              ? "Das ist ein Maschinentyp — Menge und Ausgabe laufen über den Maschinen-Tab, nicht über den Bestand."
              : "This is a machine type — quantity and checkout happen in the Machines tab, not here."}
          </p>
        )}
        {isArchived && (
          <p className="stock-lookup-note muted">
            {de
              ? "Dieser Artikel ist archiviert. Erst über „Artikel bearbeiten“ reaktivieren, sonst verschwindet die Buchung aus der Liste."
              : "This article is archived. Reactivate it under “Edit article” first, or the booking leaves the list."}
          </p>
        )}
        <div className="stock-lookup-actions">
          {offerStock && onAdjustStock && (
            <button
              type="button"
              className="werkstatt-action-btn werkstatt-action-btn--primary"
              onClick={() => onAdjustStock(article.id)}
            >
              {de ? "Bestand anpassen" : "Adjust stock"}
            </button>
          )}
          {onEditArticle && (
            <button
              type="button"
              className="werkstatt-action-btn"
              onClick={() => onEditArticle(article.id)}
            >
              {de ? "Artikel bearbeiten" : "Edit article"}
            </button>
          )}
          <button type="button" className="werkstatt-action-btn" onClick={onBack}>
            {de ? "Anderen Code scannen" : "Scan another code"}
          </button>
        </div>
      </div>
    );
  }

  if (result.kind === "external") {
    const hit = result.hit;
    return (
      <div className="stock-lookup stock-lookup--external" role="note">
        <div className="stock-lookup-head">
          <span className="stock-lookup-badge stock-lookup-badge--external">
            {lookupHeadline(result, de)}
          </span>
          {hit.source_url && (
            /* rel="noreferrer" deliberately: the shop has no business knowing
               which internal page sent the visit. */
            <a
              className="stock-lookup-source"
              href={hit.source_url}
              target="_blank"
              rel="noreferrer noopener"
            >
              {de ? "Quelle ansehen" : "View source"}
            </a>
          )}
        </div>
        <p className="stock-lookup-note muted">
          {de
            ? "Die Felder unten sind ein Vorschlag aus einer öffentlichen Shop-Seite — bitte Bezeichnung und Einheit prüfen, bevor gespeichert wird."
            : "The fields below are a suggestion taken from a public shop page — please check the name and unit before saving."}
        </p>
      </div>
    );
  }

  if (result.kind === "catalog") {
    return (
      <div className="stock-lookup stock-lookup--catalog" role="status">
        <div className="stock-lookup-head">
          <span className="stock-lookup-badge stock-lookup-badge--catalog">
            {lookupHeadline(result, de)}
          </span>
        </div>
        <p className="stock-lookup-note muted">
          {de
            ? "Aus dem Katalog anlegen übernimmt Bezeichnung, EAN und Hersteller und verknüpft die angehakten Lieferanten mit ihrer Artikelnummer."
            : "Creating from the catalogue copies the name, EAN and manufacturer, and links each ticked supplier with its article number."}
        </p>
      </div>
    );
  }

  return (
    <div className="stock-lookup stock-lookup--none" role="status">
      <div className="stock-lookup-head">
        <span className="stock-lookup-badge">{lookupHeadline(result, de)}</span>
      </div>
      <p className="stock-lookup-note muted">{lookupDetail(result, de)}</p>
    </div>
  );
}
