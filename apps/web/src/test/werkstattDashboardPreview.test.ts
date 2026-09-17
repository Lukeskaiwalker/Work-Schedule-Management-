/**
 * The two dashboard cards that preview a full listing, and the rule that
 * decides what a block says instead of its rows.
 *
 * Both previews used to be built by a different query than the page they lead
 * to, so what they showed and what they counted were both wrong in ways the
 * screen could not disclose. These cases pin the slice and the counts that
 * replaced them — the numbers the footers print.
 */
import { describe, expect, it } from "vitest";
import {
  ON_SITE_PREVIEW_GROUP_LIMIT,
  ON_SITE_PREVIEW_ITEM_LIMIT,
  onSitePreviewFrom,
  REORDER_PREVIEW_LIMIT,
  reorderPreviewFrom,
} from "../utils/werkstattDashboardPreview";
import { blockPhaseFor } from "../components/werkstatt/dashboard/WerkstattBlockState";
import type { WerkstattOnSiteGroup } from "../utils/werkstattDashboardApi";
import type { ReorderSuggestionGroup } from "../utils/werkstattReorderApi";

function line(id: number, available: number, min: number, name = `Artikel ${id}`) {
  return {
    article_id: id,
    article_number: `SP-${id}`,
    article_name: name,
    image_url: null,
    stock_available: available,
    stock_min: min,
    suggested_quantity: 1,
    unit: "Stk",
    unit_price_cents: null,
    line_total_cents: null,
  };
}

function supplier(id: number, lines: ReturnType<typeof line>[]): ReorderSuggestionGroup {
  return {
    supplier_id: id,
    supplier_name: `Lieferant ${id}`,
    supplier_short_name: null,
    default_lead_time_days: null,
    subtotal_cents: null,
    currency: "EUR",
    lines,
  };
}

function onSiteItem(articleId: number) {
  return {
    article_id: articleId,
    article_number: `SP-${articleId}`,
    article_name: `Werkzeug ${articleId}`,
    unit: "Stk",
    image_url: null,
    quantity_out: 1,
    assignee_user_id: null,
    assignee_display_name: null,
    checked_out_at: "2026-09-01T08:00:00Z",
    expected_return_at: null,
    is_overdue: false,
  };
}

function onSiteGroup(projectId: number, itemCount: number): WerkstattOnSiteGroup {
  const items = Array.from({ length: itemCount }, (_, index) =>
    onSiteItem(projectId * 100 + index),
  );
  return {
    project_id: projectId,
    project_number: `2026-${projectId}`,
    project_title: `Halle ${projectId}`,
    item_count: items.length,
    total_quantity: items.length,
    overdue_count: 0,
    items,
  };
}

describe("reorderPreviewFrom", () => {
  it("counts the lines the Nachbestellen page lists, across suppliers", () => {
    // Not `below_min_count`: that KPI includes articles with no supplier link,
    // which the suggestion engine skips — so counting the footer against it
    // promised lines the destination never shows.
    const preview = reorderPreviewFrom([
      supplier(1, [line(1, 0, 5), line(2, 4, 5)]),
      supplier(2, [line(3, 1, 5)]),
    ]);
    expect(preview.total).toBe(3);
    expect(preview.lines).toHaveLength(3);
  });

  it("puts the deepest shortfall first and cuts at the preview length", () => {
    const lines = Array.from({ length: REORDER_PREVIEW_LIMIT + 3 }, (_, index) =>
      line(index + 1, index, 10),
    );
    const preview = reorderPreviewFrom([supplier(1, lines)]);
    expect(preview.lines).toHaveLength(REORDER_PREVIEW_LIMIT);
    expect(preview.total).toBe(REORDER_PREVIEW_LIMIT + 3);
    expect(preview.lines[0].article_id).toBe(1);
  });

  it("is empty rather than undefined when nothing is suggested", () => {
    expect(reorderPreviewFrom([])).toEqual({ lines: [], total: 0 });
  });
});

describe("onSitePreviewFrom", () => {
  it("slices sites and rows and says how much it left out", () => {
    const preview = onSitePreviewFrom([
      onSiteGroup(1, ON_SITE_PREVIEW_ITEM_LIMIT + 2),
      onSiteGroup(2, 1),
      onSiteGroup(3, 1),
      onSiteGroup(4, 1),
      onSiteGroup(5, 1),
    ]);
    expect(preview.groups).toHaveLength(ON_SITE_PREVIEW_GROUP_LIMIT);
    expect(preview.groups[0].items).toHaveLength(ON_SITE_PREVIEW_ITEM_LIMIT);
    expect(preview.hiddenGroups).toBe(2);
    // Only the rows cut inside a SHOWN site — rows of a hidden site are
    // already covered by `hiddenGroups`, and counting them twice would make
    // the footer claim more is missing than there is.
    expect(preview.hiddenItems).toBe(2);
  });

  it("leaves the source untouched", () => {
    const groups = [onSiteGroup(1, ON_SITE_PREVIEW_ITEM_LIMIT + 1)];
    onSitePreviewFrom(groups);
    expect(groups[0].items).toHaveLength(ON_SITE_PREVIEW_ITEM_LIMIT + 1);
  });

  it("hides nothing when the whole list fits", () => {
    const preview = onSitePreviewFrom([onSiteGroup(1, 2), onSiteGroup(2, 1)]);
    expect(preview.hiddenGroups).toBe(0);
    expect(preview.hiddenItems).toBe(0);
  });
});

describe("blockPhaseFor", () => {
  it("calls the frame before the first request loading, not empty", () => {
    // The fetch starts in an effect after the first paint, so a `loading` flag
    // is still false there. A block that read that frame as empty printed
    // "Alles über Mindestbestand." before it had asked the server anything.
    expect(blockPhaseFor({ data: null, error: null }, undefined)).toBe("loading");
    expect(blockPhaseFor({ data: null, error: null }, 0)).toBe("loading");
  });

  it("calls a retry loading rather than keeping the old failure", () => {
    // The hook clears `error` when a reload starts; data is still null.
    expect(blockPhaseFor({ data: null, error: null }, undefined)).toBe("loading");
  });

  it("separates a failed load from an empty one", () => {
    expect(blockPhaseFor({ data: null, error: "Bad Gateway" }, undefined)).toBe("failed");
    expect(blockPhaseFor({ data: [], error: null }, 0)).toBe("empty");
  });

  it("renders the rows once there are any", () => {
    expect(blockPhaseFor({ data: [1], error: null }, 1)).toBeNull();
  });
});
