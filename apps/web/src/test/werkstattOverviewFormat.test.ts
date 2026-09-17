/**
 * The two overview screens agree on what a deadline means because they share
 * these functions. The cases pinned here are the ones where "roughly right"
 * shows up as a wrong colour on a shop floor: an item due at 09:00 today is
 * "Heute zurück" until midnight, not "überfällig" from 09:01.
 */
import { describe, expect, it } from "vitest";
import {
  dueStatus,
  formatDueLabel,
  formatRelativeTime,
  movementPipKind,
  formatCents,
  formatQuantity,
  pluralize,
} from "../utils/werkstattOverviewFormat";
import {
  articlesOnSeveralSites,
  computeOnSiteTotals,
  filterOnSiteGroups,
} from "../utils/werkstattOnSiteTotals";
import type { WerkstattOnSiteGroup } from "../utils/werkstattDashboardApi";

/** Local-time instants throughout: `dueStatus` groups by the viewer's
 *  calendar day, so UTC literals near midnight would make these cases pass or
 *  fail depending on the machine's timezone. */
function local(year: number, month: number, day: number, hour: number, minute = 0): string {
  return new Date(year, month - 1, day, hour, minute, 0, 0).toISOString();
}

const NOW = new Date(2026, 8, 17, 14, 0, 0, 0);

function item(overrides: Partial<WerkstattOnSiteGroup["items"][number]> = {}) {
  return {
    article_id: 1,
    article_number: "SP-0001",
    article_name: "Bohrhammer",
    unit: "Stk",
    image_url: null,
    quantity_out: 1,
    assignee_user_id: 4,
    assignee_display_name: "Tim Techniker",
    checked_out_at: local(2026, 9, 10, 8),
    expected_return_at: null,
    is_overdue: false,
    ...overrides,
  };
}

function group(overrides: Partial<WerkstattOnSiteGroup> = {}): WerkstattOnSiteGroup {
  const items = overrides.items ?? [item()];
  return {
    project_id: 3,
    project_number: "2026-110",
    project_title: "Halle A",
    item_count: items.length,
    total_quantity: items.reduce((sum, row) => sum + row.quantity_out, 0),
    overdue_count: items.filter((row) => row.is_overdue).length,
    ...overrides,
    items,
  };
}

describe("dueStatus", () => {
  it("calls a deadline that has already passed overdue, same day or not", () => {
    // The server stamps is_overdue with exactly this rule, and the KPI strip
    // counts that flag — so a later hour today cannot read as still-due.
    expect(dueStatus(local(2026, 9, 17, 9), NOW)).toBe("overdue");
    expect(dueStatus(local(2026, 9, 16, 23), NOW)).toBe("overdue");
  });

  it("uses the calendar day for everything still open", () => {
    expect(dueStatus(local(2026, 9, 17, 18), NOW)).toBe("due_today");
    expect(dueStatus(local(2026, 9, 20, 9), NOW)).toBe("due_soon");
    expect(dueStatus(local(2026, 10, 30, 9), NOW)).toBe("on_site");
  });

  it("says no_date rather than inventing one", () => {
    expect(dueStatus(null, NOW)).toBe("no_date");
    expect(formatDueLabel(null, NOW, true)).toBe("Ohne Rückgabedatum");
  });
});

describe("formatDueLabel", () => {
  it("counts the days late", () => {
    expect(formatDueLabel(local(2026, 9, 14, 9), NOW, true)).toBe("3 Tage überfällig");
    expect(formatDueLabel(local(2026, 9, 16, 9), NOW, true)).toBe("1 Tag überfällig");
    expect(formatDueLabel(local(2026, 9, 16, 9), NOW, false)).toBe("1 day overdue");
  });

  it("does not say '0 Tage überfällig' for a deadline that lapsed today", () => {
    expect(formatDueLabel(local(2026, 9, 17, 9), NOW, true)).toBe("Heute fällig gewesen");
  });

  it("names today and tomorrow", () => {
    expect(formatDueLabel(local(2026, 9, 17, 23), NOW, true)).toBe("Heute zurück");
    expect(formatDueLabel(local(2026, 9, 18, 7), NOW, true)).toBe("Morgen zurück");
  });
});

describe("formatRelativeTime", () => {
  it("climbs from minutes to hours to days", () => {
    expect(formatRelativeTime(local(2026, 9, 17, 13, 45), NOW, true)).toBe("vor 15 Min.");
    expect(formatRelativeTime(local(2026, 9, 17, 9), NOW, true)).toBe("vor 5 Std.");
    expect(formatRelativeTime(local(2026, 9, 15, 14), NOW, true)).toBe("vor 2 T.");
  });

  it("does not turn a missing timestamp into 'gerade eben'", () => {
    expect(formatRelativeTime(null, NOW, true)).toBe("—");
  });
});

describe("movementPipKind", () => {
  it("maps all eight ledger types onto the four pips", () => {
    expect(movementPipKind("checkout")).toBe("out");
    expect(movementPipKind("return")).toBe("in");
    expect(movementPipKind("intake")).toBe("in");
    expect(movementPipKind("repair_back")).toBe("in");
    expect(movementPipKind("repair_out")).toBe("repair");
    expect(movementPipKind("correction")).toBe("adjust");
    expect(movementPipKind("inventory_plus")).toBe("adjust");
    expect(movementPipKind("inventory_minus")).toBe("adjust");
  });
});

describe("small formatters", () => {
  it("keeps a missing price missing", () => {
    expect(formatCents(null, true)).toBeNull();
    expect(formatCents(4599, true)).toContain("45,99");
  });

  it("appends the unit only when there is one", () => {
    expect(formatQuantity(3, "Rolle")).toBe("3 Rolle");
    expect(formatQuantity(3, null)).toBe("3");
    expect(formatQuantity(3, "  ")).toBe("3");
  });

  it("picks the German singular", () => {
    expect(pluralize(1, "Projekt", "Projekten")).toBe("1 Projekt");
    expect(pluralize(2, "Projekt", "Projekten")).toBe("2 Projekten");
  });
});

describe("computeOnSiteTotals", () => {
  it("counts lines and excludes the no-project bucket from sites", () => {
    const totals = computeOnSiteTotals(
      [
        group({
          items: [
            item({ quantity_out: 2, is_overdue: true, expected_return_at: local(2026, 9, 10, 8) }),
            item({ article_id: 2, quantity_out: 3, expected_return_at: local(2026, 9, 17, 18) }),
          ],
        }),
        group({
          project_id: null,
          project_number: null,
          project_title: null,
          items: [item({ article_id: 3, quantity_out: 1 })],
        }),
      ],
      NOW,
    );
    expect(totals.lineCount).toBe(3);
    expect(totals.projectCount).toBe(1);
    expect(totals.overdue).toBe(1);
    expect(totals.dueToday).toBe(1);
  });
});

describe("filterOnSiteGroups", () => {
  const groups = [
    group({
      items: [
        item({ article_name: "Bohrhammer", is_overdue: true, expected_return_at: local(2026, 9, 10, 8) }),
        item({
          article_id: 2,
          article_number: "SP-0002",
          article_name: "Kabeltrommel",
          expected_return_at: local(2026, 9, 19, 8),
        }),
      ],
    }),
  ];

  it("drops groups that end up empty", () => {
    expect(filterOnSiteGroups(groups, "overdue", "", NOW)[0].items).toHaveLength(1);
    expect(filterOnSiteGroups(groups, "all", "gibtesnicht", NOW)).toHaveLength(0);
  });

  it("recounts the group header from what survived the filter", () => {
    const [narrowed] = filterOnSiteGroups(groups, "overdue", "", NOW);
    expect(narrowed.item_count).toBe(1);
    expect(narrowed.overdue_count).toBe(1);
  });

  it("keeps the whole site when the search matched the project, not an article", () => {
    const [hit] = filterOnSiteGroups(groups, "all", "2026-110", NOW);
    expect(hit.items).toHaveLength(2);
  });

  it("searches article number and assignee too", () => {
    expect(filterOnSiteGroups(groups, "all", "sp-0001", NOW)[0].items).toHaveLength(1);
    expect(filterOnSiteGroups(groups, "all", "tim", NOW)[0].items).toHaveLength(2);
  });
});

describe("articlesOnSeveralSites", () => {
  it("finds the articles a return cannot be attributed to a site for", () => {
    const shared = articlesOnSeveralSites([
      group({ items: [item({ article_id: 1 }), item({ article_id: 2 })] }),
      group({ project_id: 9, project_number: "2026-220", items: [item({ article_id: 2 })] }),
    ]);
    expect([...shared]).toEqual([2]);
  });

  it("is empty when every article sits at one site", () => {
    expect(articlesOnSeveralSites([group()]).size).toBe(0);
  });

  it("does not call two rows at ONE site several sites", () => {
    // The endpoint keys rows on (site, person, deadline), so one drum out to
    // two people on one job is two rows inside one group. Flagging it would
    // print "auf mehreren Baustellen" over an article that is at exactly one,
    // and a reader who checks once stops believing the rows where it is true.
    const shared = articlesOnSeveralSites([
      group({
        items: [
          item({ article_id: 4, assignee_user_id: 7, assignee_display_name: "Meier" }),
          item({ article_id: 4, assignee_user_id: 8, assignee_display_name: "Krüger" }),
        ],
      }),
    ]);
    expect(shared.size).toBe(0);
  });

  it("puts the no-project bucket on the other side of the line", () => {
    // A drum out to a site and another booked without one really is in two
    // places as far as a return's attribution is concerned.
    const shared = articlesOnSeveralSites([
      group({ items: [item({ article_id: 5 })] }),
      group({ project_id: null, project_number: null, items: [item({ article_id: 5 })] }),
    ]);
    expect([...shared]).toEqual([5]);
  });
});
