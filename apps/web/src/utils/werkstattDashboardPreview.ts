// Turning two full listings into the two dashboard cards that preview them.
//
// Both cards used to be fed by their own server-side preview block, and both
// previews disagreed with the screen their button opens. The reorder preview
// picked the five articles furthest below minimum from stock alone, while
// `/werkstatt/reorder/suggestions` — the page the "Bestellen" button leads to —
// drops every article with no supplier link. The on-site preview counted raw
// `checkout` ledger rows, so a tool returned in March was still listed in
// September, with a red dot and "191 Tage überfällig" on it.
//
// So the dashboard now reads the SAME two endpoints its buttons lead to and
// slices them here. A preview that is a slice of the destination can be wrong
// about how much it is not showing, which a footer can state; a preview from a
// different query is wrong about what it IS showing, which nothing can.

import type { WerkstattOnSiteGroup } from "./werkstattDashboardApi";
import type {
  ReorderSuggestionGroup,
  ReorderSuggestionLine,
} from "./werkstattReorderApi";

/** Rows per card. Matches what the server-side preview blocks used to send,
 *  so the cards keep the height the layout was built around. */
export const REORDER_PREVIEW_LIMIT = 5;
export const ON_SITE_PREVIEW_GROUP_LIMIT = 3;
export const ON_SITE_PREVIEW_ITEM_LIMIT = 5;

export interface ReorderPreview {
  /** The most urgent lines, already cut to `REORDER_PREVIEW_LIMIT`. */
  lines: ReorderSuggestionLine[];
  /** Lines the Nachbestellen page lists in total — what "N weitere" counts
   *  against. Never the KPI's `below_min_count`, which includes articles that
   *  page cannot show. */
  total: number;
}

/**
 * Flatten the supplier groups and keep the most urgent lines.
 *
 * "Most urgent" is `stock_available - stock_min` ascending — the same order
 * the old server-side preview used, so the card shows the lines a reader
 * already expects at the top, just drawn from the honest source.
 */
export function reorderPreviewFrom(
  groups: ReadonlyArray<ReorderSuggestionGroup>,
): ReorderPreview {
  const lines = groups.flatMap((group) => group.lines);
  const ordered = [...lines].sort((a, b) => {
    const deficit = a.stock_available - a.stock_min - (b.stock_available - b.stock_min);
    if (deficit !== 0) return deficit;
    return a.article_name.localeCompare(b.article_name);
  });
  return { lines: ordered.slice(0, REORDER_PREVIEW_LIMIT), total: ordered.length };
}

export interface OnSitePreview {
  groups: WerkstattOnSiteGroup[];
  /** Sites the slice left out entirely. */
  hiddenGroups: number;
  /** Rows left out INSIDE the sites that are shown. Rows belonging to a
   *  hidden site are not counted here — `hiddenGroups` already accounts for
   *  those, and adding them twice would make the footer read as more missing
   *  than there is. */
  hiddenItems: number;
}

/**
 * The first few sites, with the first few rows each.
 *
 * The endpoint already sorts sites with something overdue first and, inside a
 * site, the late rows first — so the top of its answer is what a preview
 * wants, and the counts below say exactly how much was left off.
 */
export function onSitePreviewFrom(
  groups: ReadonlyArray<WerkstattOnSiteGroup>,
): OnSitePreview {
  const shown = groups.slice(0, ON_SITE_PREVIEW_GROUP_LIMIT);
  return {
    groups: shown.map((group) => ({
      ...group,
      items: group.items.slice(0, ON_SITE_PREVIEW_ITEM_LIMIT),
    })),
    hiddenGroups: Math.max(0, groups.length - ON_SITE_PREVIEW_GROUP_LIMIT),
    hiddenItems: shown.reduce(
      (sum, group) => sum + Math.max(0, group.items.length - ON_SITE_PREVIEW_ITEM_LIMIT),
      0,
    ),
  };
}
