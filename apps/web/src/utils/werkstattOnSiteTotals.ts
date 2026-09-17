// Client-side shaping for the "Auf Baustelle" list: totals, filter, search.
//
// All three run over what `/werkstatt/on-site` already returned. That is a
// deliberate split from the Bedarfe screen, which filters server-side: this
// list is bounded by how much stock is out of the workshop at once (tens of
// rows), and the KPI strip has to count the WHOLE population while the list
// below shows a narrowed slice — two numbers that a server-side filter would
// have to fetch twice to produce.

import { dueStatus } from "./werkstattOverviewFormat";
import type {
  WerkstattOnSiteGroup,
  WerkstattOnSiteItem,
} from "./werkstattDashboardApi";
import type { OnSiteTotals } from "../components/werkstatt/onsite/OnSiteKpiStrip";

export type OnSiteFilterKey = "all" | "active" | "overdue" | "due_today" | "this_week";

export interface OnSiteFilterDef {
  key: OnSiteFilterKey;
  label_de: string;
  label_en: string;
}

export const ON_SITE_FILTERS: ReadonlyArray<OnSiteFilterDef> = [
  { key: "all", label_de: "Alle", label_en: "All" },
  { key: "active", label_de: "Aktiv", label_en: "Active" },
  { key: "overdue", label_de: "Überfällig", label_en: "Overdue" },
  { key: "due_today", label_de: "Heute", label_en: "Today" },
  { key: "this_week", label_de: "Diese Woche", label_en: "This week" },
];

/**
 * Lateness comes from the server's `is_overdue`, not from a second opinion
 * computed here: the KPI strip counts that same flag, and a filter that
 * disagreed with it would show four rows under a tile reading three.
 */
export function itemMatchesFilter(
  item: WerkstattOnSiteItem,
  filter: OnSiteFilterKey,
  now: Date,
): boolean {
  if (filter === "all") return true;
  if (filter === "overdue") return item.is_overdue;
  if (filter === "active") return !item.is_overdue;
  const status = dueStatus(item.expected_return_at, now);
  if (filter === "due_today") return !item.is_overdue && status === "due_today";
  // "this_week" — still open and due within seven days.
  return !item.is_overdue && (status === "due_today" || status === "due_soon");
}

function itemMatchesSearch(item: WerkstattOnSiteItem, needle: string): boolean {
  if (!needle) return true;
  return [item.article_name, item.article_number, item.assignee_display_name ?? ""]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

function groupMatchesSearch(group: WerkstattOnSiteGroup, needle: string): boolean {
  if (!needle) return false;
  // Number and title only — the endpoint deliberately sends no customer name,
  // so there is nothing else here to match against.
  return [group.project_number ?? "", group.project_title ?? ""]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

/**
 * Narrow the groups, dropping any that end up with no rows.
 *
 * A search hit on the PROJECT keeps the whole group: someone typing a project
 * number wants that site's list, not the subset of its articles whose names
 * happen to contain the same digits.
 */
export function filterOnSiteGroups(
  groups: ReadonlyArray<WerkstattOnSiteGroup>,
  filter: OnSiteFilterKey,
  search: string,
  now: Date,
): WerkstattOnSiteGroup[] {
  const needle = search.trim().toLowerCase();
  const result: WerkstattOnSiteGroup[] = [];
  for (const group of groups) {
    const projectHit = groupMatchesSearch(group, needle);
    const items = group.items.filter(
      (item) =>
        itemMatchesFilter(item, filter, now) &&
        (projectHit || itemMatchesSearch(item, needle)),
    );
    if (items.length === 0) continue;
    result.push({
      ...group,
      items,
      item_count: items.length,
      total_quantity: items.reduce((sum, item) => sum + item.quantity_out, 0),
      overdue_count: items.filter((item) => item.is_overdue).length,
    });
  }
  return result;
}

/** Headline totals over the UNFILTERED response. */
export function computeOnSiteTotals(
  groups: ReadonlyArray<WerkstattOnSiteGroup>,
  now: Date,
): OnSiteTotals {
  let lineCount = 0;
  let dueToday = 0;
  let overdue = 0;
  let projectCount = 0;
  for (const group of groups) {
    // The nameless bucket holds checkouts booked without a building site. They
    // are real rows, but they are not a site, so they must not inflate the
    // "auf Projekten" count.
    if (group.project_id != null) projectCount += 1;
    for (const item of group.items) {
      lineCount += 1;
      // Same precedence as the filter chips: a late item is counted as late,
      // never a second time under "heute zurück".
      if (item.is_overdue) overdue += 1;
      else if (dueStatus(item.expected_return_at, now) === "due_today") dueToday += 1;
    }
  }
  return { lineCount, projectCount, dueToday, overdue };
}

/**
 * Articles that are out on more than one building site at the same time.
 *
 * These are the rows where this page can mislead, and the limitation is in the
 * API rather than in the page: `POST /werkstatt/mobile/return` books against an
 * ARTICLE, with no project on the payload and none on the ledger row it writes.
 * The listing endpoint therefore has to guess which checkout a return settled,
 * and it guesses oldest-first. Return three drums from site B while two have
 * been open at site A since last week, and the list will show site A's row
 * shrinking instead.
 *
 * Counted per GROUP, not per row. One article can hold several rows inside one
 * group — the endpoint keys them on (site, person, deadline) — and a banner
 * that says "auf mehreren Baustellen" about a drum sitting at exactly one site
 * is a warning a reader checks once and then stops believing, including on the
 * rows where it is true.
 *
 * Nothing in the FE can fix the attribution itself — a return simply does not
 * record where it came from. So the page says so, and only for the articles it
 * can actually happen to.
 */
export function articlesOnSeveralSites(
  groups: ReadonlyArray<WerkstattOnSiteGroup>,
): ReadonlySet<number> {
  const sitesByArticle = new Map<number, Set<string>>();
  for (const group of groups) {
    const groupKey = String(group.project_id ?? "none");
    for (const item of group.items) {
      const sites = sitesByArticle.get(item.article_id) ?? new Set<string>();
      sites.add(groupKey);
      sitesByArticle.set(item.article_id, sites);
    }
  }
  const shared = new Set<number>();
  for (const [articleId, sites] of sitesByArticle) {
    if (sites.size > 1) shared.add(articleId);
  }
  return shared;
}
