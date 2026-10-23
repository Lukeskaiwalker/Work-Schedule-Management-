/**
 * The board's WAGO terminals, derived once per document
 * (docs/PANEL_ENCLOSURE_R2.md §3.1, §6.7).
 *
 * SchaltplanPage calls this once and passes the answer down to the legend,
 * the findings, the Klemmen tab, the label dialog and the Schrank tab, so
 * every one of them numbers the same X labels: on a cabinet board the skip
 * set (no WAGO on AAR, NAR, RfZ or APZ rails) shifts the numbering, and a
 * view that derived its own without it would disagree with the print.
 *
 * `ready` is false while a cabinet board's catalogue index loads — the skip
 * set needs the zones, and numbers shown before it lands would shift once it
 * does ("Schrankkatalog wird geladen…"). A board without a cabinet needs no
 * catalogue and is ready at once. `boardTerminals`/`placeTerminals` memoise
 * by document identity too, so a second caller costs a lookup.
 */
import { useMemo } from "react";

import { catalogIndex, type CatalogIndex } from "../utils/enclosureCatalog";
import { boardTerminals, enclosureOf, placeTerminals, type BoardTerminals } from "../utils/enclosureTerminals";
import type { TerminalPlacement } from "../types/panelEnclosure";
import type { PanelDocument } from "../types/schaltplan";

export interface BoardTerminalsState {
  ready: boolean;
  terms: BoardTerminals | null;
  placement: TerminalPlacement | null;
}

const NOT_READY: BoardTerminalsState = Object.freeze({ ready: false, terms: null, placement: null });

/** What a board without a cabinet is derived against: it never reads the catalogue. */
const NO_CATALOG: CatalogIndex = catalogIndex({ enclosures: [], modules: [], can_manage: false, uncatalogued: [] });

/** The hook's answer as a pure function, for callers outside React. */
export function boardTerminalsState(doc: PanelDocument | null, index: CatalogIndex | null): BoardTerminalsState {
  if (!doc) return NOT_READY;
  if (enclosureOf(doc) && !index) return NOT_READY;
  const lookup = index ?? NO_CATALOG;
  const terms = boardTerminals(doc, lookup);
  return { ready: true, terms, placement: placeTerminals(doc, lookup, terms) };
}

export function useBoardTerminals(doc: PanelDocument | null, index: CatalogIndex | null): BoardTerminalsState {
  return useMemo(() => boardTerminalsState(doc, index), [doc, index]);
}
