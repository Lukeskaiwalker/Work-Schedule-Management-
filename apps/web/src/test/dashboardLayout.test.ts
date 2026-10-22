/**
 * The pure layout operations behind the start-page editor (docs/DASHBOARD.md
 * §11.2, D9, D10).
 *
 * The editor is controlled and the host compares the draft with the loaded
 * layout to decide whether „Fertig“ sends anything. Both only work if no
 * operation ever changes its input: a mutated "loaded" layout would equal the
 * draft, and the save would silently be skipped.
 */
import { describe, expect, it } from "vitest";

import {
  DASHBOARD_COLUMNS,
  DASHBOARD_ROW_LIMIT,
  addWidget,
  columnSpan,
  deviceFromMatches,
  moveWidget,
  moveWidgetBy,
  pruneWidgets,
  removeWidget,
  resizeWidget,
  sameLayout,
  setWidgetSettings,
} from "../utils/dashboardLayout";
import type { DashboardWidgetId, DashboardWidgetItem } from "../types/dashboard";

function layout(): DashboardWidgetItem[] {
  return [
    { id: "shortcuts", size: "large", settings: { views: ["my_tasks", "planning"] } },
    { id: "my_status", size: "medium" },
    { id: "my_tasks", size: "small" },
  ];
}

/** Runs `operation` on a fresh layout and checks it neither returned nor changed its input. */
function pure(operation: (input: DashboardWidgetItem[]) => DashboardWidgetItem[]): DashboardWidgetItem[] {
  const input = layout();
  const before = structuredClone(input);
  const result = operation(input);
  expect(result).not.toBe(input);
  expect(input).toEqual(before);
  return result;
}

const ids = (widgets: readonly DashboardWidgetItem[]) => widgets.map((item) => item.id);

describe("constants", () => {
  it("row limits are 3 / 5 / 10 and columns 1 / 2 / 3", () => {
    expect(DASHBOARD_ROW_LIMIT).toEqual({ small: 3, medium: 5, large: 10 });
    expect(DASHBOARD_COLUMNS).toEqual({ mobile: 1, tablet: 2, desktop: 3 });
  });
});

describe("columnSpan", () => {
  it("S is one column, M two, L the full row — clamped to the device", () => {
    expect(columnSpan("small", "desktop")).toBe(1);
    expect(columnSpan("medium", "desktop")).toBe(2);
    expect(columnSpan("large", "desktop")).toBe(3);
    expect(columnSpan("small", "tablet")).toBe(1);
    expect(columnSpan("medium", "tablet")).toBe(2);
    expect(columnSpan("large", "tablet")).toBe(2);
    expect(columnSpan("small", "mobile")).toBe(1);
    expect(columnSpan("medium", "mobile")).toBe(1);
    expect(columnSpan("large", "mobile")).toBe(1);
  });
});

describe("deviceFromMatches", () => {
  it("maps the two width queries, with the desktop query winning", () => {
    expect(deviceFromMatches(false, false)).toBe("mobile");
    expect(deviceFromMatches(true, false)).toBe("tablet");
    expect(deviceFromMatches(true, true)).toBe("desktop");
    // Cannot happen with real widths; desktop still wins so no width is unmapped.
    expect(deviceFromMatches(false, true)).toBe("desktop");
  });
});

describe("moveWidget", () => {
  it("moves an item to a new index without touching the input", () => {
    expect(ids(pure((input) => moveWidget(input, 0, 2)))).toEqual(["my_status", "my_tasks", "shortcuts"]);
    expect(ids(pure((input) => moveWidget(input, 2, 0)))).toEqual(["my_tasks", "shortcuts", "my_status"]);
  });

  it("clamps the target and ignores an index outside the list", () => {
    expect(ids(pure((input) => moveWidget(input, 0, 99)))).toEqual(["my_status", "my_tasks", "shortcuts"]);
    expect(ids(pure((input) => moveWidget(input, 7, 0)))).toEqual(["shortcuts", "my_status", "my_tasks"]);
    expect(ids(pure((input) => moveWidget(input, -1, 0)))).toEqual(["shortcuts", "my_status", "my_tasks"]);
  });
});

describe("moveWidgetBy", () => {
  it("swaps with the neighbour", () => {
    expect(ids(pure((input) => moveWidgetBy(input, "my_status", -1)))).toEqual(["my_status", "shortcuts", "my_tasks"]);
    expect(ids(pure((input) => moveWidgetBy(input, "my_status", 1)))).toEqual(["shortcuts", "my_tasks", "my_status"]);
  });

  it("stays put at the ends and for an id that is not placed", () => {
    expect(ids(pure((input) => moveWidgetBy(input, "shortcuts", -1)))).toEqual(["shortcuts", "my_status", "my_tasks"]);
    expect(ids(pure((input) => moveWidgetBy(input, "my_tasks", 1)))).toEqual(["shortcuts", "my_status", "my_tasks"]);
    expect(ids(pure((input) => moveWidgetBy(input, "clocked_in", 1)))).toEqual(["shortcuts", "my_status", "my_tasks"]);
  });
});

describe("addWidget", () => {
  it("appends at the given size", () => {
    const result = pure((input) => addWidget(input, "notifications", "small"));
    expect(result[result.length - 1]).toEqual({ id: "notifications", size: "small" });
    expect(result).toHaveLength(4);
  });

  it("never duplicates a placed widget", () => {
    const result = pure((input) => addWidget(input, "my_status", "large"));
    expect(ids(result)).toEqual(["shortcuts", "my_status", "my_tasks"]);
    expect(result[1].size).toBe("medium");
  });
});

describe("removeWidget / resizeWidget", () => {
  it("removes by id", () => {
    expect(ids(pure((input) => removeWidget(input, "my_status")))).toEqual(["shortcuts", "my_tasks"]);
    expect(ids(pure((input) => removeWidget(input, "clocked_in")))).toEqual(["shortcuts", "my_status", "my_tasks"]);
  });

  it("changes one item's size and keeps its settings", () => {
    const result = pure((input) => resizeWidget(input, "shortcuts", "small"));
    expect(result[0]).toEqual({ id: "shortcuts", size: "small", settings: { views: ["my_tasks", "planning"] } });
    expect(result[1]).toEqual({ id: "my_status", size: "medium" });
  });
});

describe("setWidgetSettings", () => {
  it("replaces the settings with a copy", () => {
    const views: ("time" | "wiki")[] = ["time", "wiki"];
    const result = pure((input) => setWidgetSettings(input, "shortcuts", { views }));
    expect(result[0].settings).toEqual({ views: ["time", "wiki"] });
    views.push("wiki");
    expect(result[0].settings).toEqual({ views: ["time", "wiki"] });
  });

  it("null drops the key altogether — never `settings: null`", () => {
    const result = pure((input) => setWidgetSettings(input, "shortcuts", null));
    expect(result[0]).toEqual({ id: "shortcuts", size: "large" });
    expect("settings" in result[0]).toBe(false);
  });
});

describe("pruneWidgets", () => {
  it("keeps only the ids in the set, in order", () => {
    const keep = new Set<DashboardWidgetId>(["my_tasks", "shortcuts"]);
    expect(ids(pure((input) => pruneWidgets(input, keep)))).toEqual(["shortcuts", "my_tasks"]);
  });
});

describe("sameLayout", () => {
  it("compares ids, order, sizes and tiles", () => {
    expect(sameLayout(layout(), layout())).toBe(true);
    expect(sameLayout(layout(), moveWidget(layout(), 0, 1))).toBe(false);
    expect(sameLayout(layout(), resizeWidget(layout(), "my_tasks", "large"))).toBe(false);
    expect(sameLayout(layout(), setWidgetSettings(layout(), "shortcuts", { views: ["planning", "my_tasks"] }))).toBe(false);
    expect(sameLayout(layout(), layout().slice(0, 2))).toBe(false);
    expect(sameLayout([], [])).toBe(true);
  });

  it("treats missing and null settings as equal", () => {
    const withNull = [{ id: "my_status", size: "medium", settings: null }] as unknown as DashboardWidgetItem[];
    expect(sameLayout([{ id: "my_status", size: "medium" }], withNull)).toBe(true);
    expect(sameLayout(withNull, [{ id: "my_status", size: "medium" }])).toBe(true);
  });
});
