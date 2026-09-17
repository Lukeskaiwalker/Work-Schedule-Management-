// "What is this code?" — the cascade behind the create dialog's first step.
//
// Backend: apps/api/app/routers/workflow_werkstatt_article_lookup.py
//   GET /werkstatt/articles/lookup?code=&allow_external=
//
// Three answers matter to the caller and they are genuinely different things,
// which is why the result is a union rather than a nullable article:
//
//   existing → STOP. Creating a second row for something on the shelf is the
//              duplicate the merge screen then has to clean up.
//   catalog  → create from the wholesaler's row, which brings their article
//              number and their supplier link with it.
//   external → a suggestion from a public shop. Shown behind a banner, every
//              field editable, because a scrape is a guess.
//   none     → an empty form, and a sentence saying why nothing was found.

import { apiFetch } from "../api/client";
import type { WerkstattArticleLookup } from "../types/werkstatt";

export interface LookupOptions {
  /** False keeps the request inside SMPL — no webshop, no GTIN database.
   *  Use it for anything that runs while somebody is typing: the external
   *  half can make the server fetch a product page. */
  allowExternal?: boolean;
}

export async function lookupArticleCode(
  token: string | null,
  code: string,
  options: LookupOptions = {},
): Promise<WerkstattArticleLookup> {
  const params = new URLSearchParams({ code });
  if (options.allowExternal === false) params.set("allow_external", "false");
  return apiFetch<WerkstattArticleLookup>(
    `/werkstatt/articles/lookup?${params.toString()}`,
    token,
  );
}

/**
 * The human-readable half of a lookup, in one place.
 *
 * Kept out of the components because three of them render the same four
 * outcomes — the create dialog, the mobile scanner and the duplicates hand-off
 * — and a fourth wording of "Nichts gefunden" is how two screens start
 * disagreeing about what the server said.
 */
export function lookupHeadline(result: WerkstattArticleLookup, de: boolean): string {
  switch (result.kind) {
    case "existing":
      return de ? "Bereits im Bestand" : "Already in stock";
    case "catalog":
      return de ? "Im Lieferantenkatalog gefunden" : "Found in the supplier catalogue";
    case "external":
      return de
        ? "Vorschlag aus Unielektro-Webshop — bitte prüfen"
        : "Suggestion from the Unielektro webshop — please check";
    default:
      return de ? "Nichts gefunden — bitte Daten eingeben" : "Nothing found — please enter the data";
  }
}

/** The second line: why, when the answer was "nothing". */
export function lookupDetail(result: WerkstattArticleLookup, de: boolean): string | null {
  if (result.kind !== "none") return null;
  if (result.external_skipped === "not_a_gtin") {
    return de
      ? "Der Code ist kein Barcode (EAN/GTIN) — im Webshop lässt sich damit nichts suchen."
      : "The code is not a barcode (EAN/GTIN), so the webshop cannot be searched for it.";
  }
  if (result.external_skipped === "disabled") {
    return de
      ? "Die Webshop-Suche ist abgeschaltet."
      : "The webshop lookup is switched off.";
  }
  if (result.external_skipped === "not_requested") {
    /* A different fact with a different fix. The caller asked for a cheap
     * internal answer; telling the workshop the webshop search is switched
     * off would send somebody to edit .env over a decision this screen made. */
    return de
      ? "Nur im Bestand und im Lieferantenkatalog gesucht."
      : "Searched stock and the supplier catalogue only.";
  }
  return de
    ? "Weder im Bestand noch im Lieferantenkatalog noch im Webshop."
    : "Not in stock, not in the supplier catalogue, not in the webshop.";
}
