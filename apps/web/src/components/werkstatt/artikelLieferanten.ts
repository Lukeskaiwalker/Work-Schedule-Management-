/**
 * Supplier-link edits in the "Artikel bearbeiten" dialog, as pure data.
 *
 * The dialog used to show "Lieferant" and "Lieferanten-Art.-Nr." as ordinary
 * form fields that `toUpdatePatch` never read — Save found an empty article
 * patch and closed as if it had saved, and the corrected number was gone. A
 * supplier number does not live on the article at all; it lives on the LINK
 * (`werkstatt_article_suppliers`), so it is edited there: every linked
 * supplier's number is a draft, and Save PATCHes each link whose draft
 * differs, and POSTs a supplier that was picked under "Lieferant hinzufügen"
 * but not yet added.
 *
 * Immutable throughout: drafts are replaced, never edited in place.
 */
import type { ArticleSupplierLinkCreate } from "../../utils/werkstattArticlesApi";
import type { WerkstattArticle } from "../../types/werkstatt";

/** Typed supplier numbers per link id. A link without an entry is untouched. */
export type LinkDrafts = Readonly<Record<number, string>>;

/** The "Lieferant hinzufügen" row before it is added. */
export interface NewLinkDraft {
  supplierId: number | null;
  number: string;
}

export const EMPTY_NEW_LINK: NewLinkDraft = { supplierId: null, number: "" };

export interface LinkNumberChange {
  linkId: number;
  supplier_article_no: string | null;
}

function cleanNumber(value: string): string | null {
  const text = value.trim();
  return text ? text : null;
}

export function withLinkDraft(drafts: LinkDrafts, linkId: number, value: string): LinkDrafts {
  return { ...drafts, [linkId]: value };
}

/** What the input for one link shows: the draft, or the stored number. */
export function linkNumberValue(
  drafts: LinkDrafts,
  link: { id: number; supplier_article_no: string | null },
): string {
  return drafts[link.id] ?? link.supplier_article_no ?? "";
}

/** Every link whose typed number differs from the stored one (after trim). */
export function changedLinkNumbers(
  article: Pick<WerkstattArticle, "suppliers">,
  drafts: LinkDrafts,
): LinkNumberChange[] {
  return article.suppliers.flatMap((link) => {
    if (!(link.id in drafts)) return [];
    const next = cleanNumber(drafts[link.id] ?? "");
    const stored = cleanNumber(link.supplier_article_no ?? "");
    return next === stored ? [] : [{ linkId: link.id, supplier_article_no: next }];
  });
}

/**
 * The POST body for a supplier picked but not yet added, or null.
 *
 * The first link on an article with none is preferred, or every reorder flow
 * has no supplier to target.
 */
export function pendingNewLink(
  article: Pick<WerkstattArticle, "suppliers">,
  draft: NewLinkDraft,
): ArticleSupplierLinkCreate | null {
  if (draft.supplierId == null) return null;
  return {
    supplier_id: draft.supplierId,
    supplier_article_no: cleanNumber(draft.number),
    is_preferred: article.suppliers.length === 0,
  };
}
