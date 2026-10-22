/**
 * The join between the catalog and the widget code (docs/DASHBOARD.md D24,
 * §9.7).
 *
 * Every catalog id needs metadata — the editor's placeholder tiles, the add
 * dialog and the admin tab render from it alone — and exactly one loader in
 * exactly one group, or the start page would silently skip the widget (the
 * host skips ids without a loader, to survive version skew).
 *
 * The groups land with parts W3–W5. A group either has all its loaders or
 * none; the all-twenty check runs once every group has landed and shows as
 * skipped until then, so the integrator's run cannot miss it.
 */
import { describe, expect, it } from "vitest";

import { DASHBOARD_WIDGET_META } from "../components/dashboard/widgetMeta";
import { getLazySettingsEditor, getLazyWidget } from "../components/dashboard/widgetRegistry";
import type { DashboardWidgetLoaders } from "../components/dashboard/widgetTypes";
import { OFFICE_WIDGET_LOADERS } from "../components/dashboard/widgets/office";
import { PERSONAL_WIDGET_LOADERS } from "../components/dashboard/widgets/personal";
import { PLANNING_WIDGET_LOADERS } from "../components/dashboard/widgets/planning";
import { SHORTCUT_WIDGET_LOADERS } from "../components/dashboard/widgets/shortcuts";
import { WERKSTATT_WIDGET_LOADERS } from "../components/dashboard/widgets/werkstatt";
import { DASHBOARD_WIDGET_IDS, type DashboardWidgetGroup, type DashboardWidgetId } from "../types/dashboard";

const GROUPS: { group: DashboardWidgetGroup; loaders: DashboardWidgetLoaders }[] = [
  { group: "shortcuts", loaders: SHORTCUT_WIDGET_LOADERS },
  { group: "personal", loaders: PERSONAL_WIDGET_LOADERS },
  { group: "planning", loaders: PLANNING_WIDGET_LOADERS },
  { group: "werkstatt", loaders: WERKSTATT_WIDGET_LOADERS },
  { group: "office", loaders: OFFICE_WIDGET_LOADERS },
];

const idsOfGroup = (group: DashboardWidgetGroup) =>
  DASHBOARD_WIDGET_IDS.filter((id) => DASHBOARD_WIDGET_META[id].group === group);

function loaderCount(id: DashboardWidgetId): number {
  return GROUPS.filter(({ loaders }) => Object.prototype.hasOwnProperty.call(loaders, id)).length;
}

const pendingGroups = GROUPS.filter(({ loaders }) => Object.keys(loaders).length === 0).map(({ group }) => group);

describe("widget registry", () => {
  it("has metadata with German and English title and description for every catalog id", () => {
    for (const id of DASHBOARD_WIDGET_IDS) {
      const meta = DASHBOARD_WIDGET_META[id];
      expect(meta?.id).toBe(id);
      expect(meta.title.de.trim()).not.toBe("");
      expect(meta.title.en.trim()).not.toBe("");
      expect(meta.description.de.trim()).not.toBe("");
      expect(meta.description.en.trim()).not.toBe("");
    }
  });

  it("keeps each loader in its own group, and only catalog ids", () => {
    for (const { group, loaders } of GROUPS) {
      for (const id of Object.keys(loaders)) {
        expect(DASHBOARD_WIDGET_IDS).toContain(id);
        expect(DASHBOARD_WIDGET_META[id as DashboardWidgetId].group).toBe(group);
      }
    }
    for (const id of DASHBOARD_WIDGET_IDS) expect(loaderCount(id)).toBeLessThanOrEqual(1);
  });

  it("lands a group whole: a group with any loader has one for every widget", () => {
    for (const { group, loaders } of GROUPS) {
      if (Object.keys(loaders).length === 0) continue;
      expect([group, Object.keys(loaders).sort()]).toEqual([group, [...idsOfGroup(group)].sort()]);
    }
  });

  it.skipIf(pendingGroups.length > 0)(
    `every catalog id has exactly one loader (groups still to land: ${pendingGroups.join(", ") || "none"})`,
    () => {
      for (const id of DASHBOARD_WIDGET_IDS) expect([id, loaderCount(id)]).toEqual([id, 1]);
    },
  );

  it("answers null for ids without a loader, including object-prototype names", () => {
    for (const id of ["weather", "constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(getLazyWidget(id as DashboardWidgetId)).toBeNull();
    }
    for (const id of DASHBOARD_WIDGET_IDS) {
      if (loaderCount(id) === 0) expect(getLazyWidget(id)).toBeNull();
    }
  });

  it("hands out one lazy component per id, so React never remounts a widget on re-render", () => {
    for (const id of DASHBOARD_WIDGET_IDS) {
      if (loaderCount(id) === 0) continue;
      expect(getLazyWidget(id)).toBe(getLazyWidget(id));
    }
  });

  it("has a settings editor for the shortcuts at most", () => {
    for (const id of DASHBOARD_WIDGET_IDS) {
      if (id !== "shortcuts") expect(getLazySettingsEditor(id)).toBeNull();
    }
    const shortcutsEditor = getLazySettingsEditor("shortcuts");
    expect(shortcutsEditor).toBe(getLazySettingsEditor("shortcuts"));
  });
});
