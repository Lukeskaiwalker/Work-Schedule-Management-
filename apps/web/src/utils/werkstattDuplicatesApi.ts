// The duplicate review queue.
//
// Backend: apps/api/app/routers/workflow_werkstatt_article_dedup.py
//   GET    /werkstatt/articles/duplicates
//   POST   /werkstatt/articles/duplicates/dismiss
//   DELETE /werkstatt/articles/duplicates/dismiss
//   POST   /werkstatt/articles/merge
//
// All four need `werkstatt:manage`, and all four are read ON DEMAND — the
// listing is an O(n²) name comparison server-side, so it is fetched when the
// dialog opens and never while somebody types.

import { apiFetch } from "../api/client";
import type {
  WerkstattArticleMergeResult,
  WerkstattDuplicateCandidate,
} from "../types/werkstatt";

/**
 * How many pairs anybody asks for. ONE number, because the badge and the list
 * are two views of the same queue: a badge counted to 200 over a list capped
 * at 50 promised work the dialog could not show, and nothing said the queue
 * had been cut off.
 */
export const DUPLICATE_PAGE_LIMIT = 100;

export async function listDuplicateCandidates(
  token: string | null,
  limit = DUPLICATE_PAGE_LIMIT,
): Promise<WerkstattDuplicateCandidate[]> {
  return apiFetch<WerkstattDuplicateCandidate[]>(
    `/werkstatt/articles/duplicates?limit=${limit}`,
    token,
  );
}

/**
 * "Kein Duplikat" — stop offering this pair.
 *
 * Order-independent on the server (it stores the pair with the lower id
 * first), which matters because the finder does not promise which side it
 * shows first: a judgement keyed on the display order would be undone by the
 * next article somebody adds.
 */
export async function dismissDuplicatePair(
  token: string | null,
  articleId: number,
  duplicateId: number,
): Promise<void> {
  await apiFetch<unknown>("/werkstatt/articles/duplicates/dismiss", token, {
    method: "POST",
    body: JSON.stringify({ article_id: articleId, duplicate_id: duplicateId }),
  });
}

/** Undo a dismissal; the pair reappears in the queue. */
export async function restoreDuplicatePair(
  token: string | null,
  articleId: number,
  duplicateId: number,
): Promise<void> {
  const params = new URLSearchParams({
    article_id: String(articleId),
    duplicate_id: String(duplicateId),
  });
  await apiFetch<unknown>(`/werkstatt/articles/duplicates/dismiss?${params.toString()}`, token, {
    method: "DELETE",
  });
}

/**
 * Fold one article into another. IRREVERSIBLE.
 *
 * The survivor keeps its number and gains everything the duplicate had:
 * movements, order lines, crate positions, machine units, stock-take counts,
 * task material lines and supplier numbers. The duplicate is archived rather
 * than deleted, and its old label keeps resolving — to the survivor.
 */
export async function mergeArticles(
  token: string | null,
  survivorId: number,
  duplicateId: number,
): Promise<WerkstattArticleMergeResult> {
  return apiFetch<WerkstattArticleMergeResult>("/werkstatt/articles/merge", token, {
    method: "POST",
    body: JSON.stringify({ survivor_id: survivorId, duplicate_id: duplicateId }),
  });
}

/**
 * What a merge moved, as one German sentence for the success toast.
 *
 * Only the non-zero parts: "Zusammengeführt: 3 Bewegungen" is a report,
 * "3 Bewegungen, 0 Bestellpositionen, 0 Kisten-Positionen …" is a form.
 */
export function mergeSummary(result: WerkstattArticleMergeResult, de: boolean): string {
  const parts: string[] = [];
  const push = (count: number, singularDe: string, pluralDe: string, en: string) => {
    if (count > 0) parts.push(`${count} ${de ? (count === 1 ? singularDe : pluralDe) : en}`);
  };
  push(result.movements_moved, "Bewegung", "Bewegungen", "movements");
  push(result.order_lines_moved, "Bestellposition", "Bestellpositionen", "order lines");
  push(result.box_items_moved, "Kisten-Position", "Kisten-Positionen", "crate positions");
  push(result.units_moved, "Maschine", "Maschinen", "machines");
  push(result.inventory_counts_moved, "Inventurzählung", "Inventurzählungen", "stock-take counts");
  push(result.task_materials_moved, "Materialzeile", "Materialzeilen", "material lines");
  push(
    result.supplier_links_moved,
    "Lieferanten-Nummer",
    "Lieferanten-Nummern",
    "supplier numbers",
  );
  /* Named, not counted. These are the numbers whose link row could not travel
   * — the survivor was already linked to that supplier — so they were adopted
   * onto its link or recorded in its notes. The confirmation promises supplier
   * numbers survive a merge; saying WHICH ones landed sideways is how somebody
   * can check that against the invoice in front of them. */
  const kept = result.supplier_numbers_kept ?? [];
  if (kept.length > 0) {
    parts.push(
      de
        ? `${kept.join(", ")} beim bestehenden Lieferanten-Eintrag hinterlegt`
        : `${kept.join(", ")} recorded on the existing supplier link`,
    );
  }
  if (parts.length === 0) {
    return de
      ? "Zusammengeführt — es gab nichts zu übertragen."
      : "Merged — there was nothing to move.";
  }
  return de
    ? `Zusammengeführt: ${parts.join(", ")} übertragen`
    : `Merged: ${parts.join(", ")} moved`;
}
