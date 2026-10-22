/**
 * The widget list the editor, the add dialog and the admin tab read.
 *
 * Placeholder tiles render from this metadata alone (docs/DASHBOARD.md D12),
 * so every catalog id needs a German and an English title and description,
 * in the group the server's catalog puts it in (§1) — the add dialog groups
 * by it. The id lists are mirrored by the API; test_dashboard_catalog_parity.py
 * holds the two sides together.
 */
import { describe, expect, it } from "vitest";

import { DASHBOARD_WIDGET_META } from "../components/dashboard/widgetMeta";
import {
  DASHBOARD_DEVICES,
  DASHBOARD_MAX_SHORTCUT_VIEWS,
  DASHBOARD_SHORTCUT_VIEWS,
  DASHBOARD_WIDGET_IDS,
  DASHBOARD_WIDGET_SIZES,
} from "../types/dashboard";
import { DASHBOARD_POLL_MS } from "../components/dashboard/dashboardPolling";

const GROUP_OF: Record<string, string> = {
  shortcuts: "shortcuts",
  my_status: "personal",
  my_tasks: "personal",
  my_vacation: "personal",
  notifications: "personal",
  planning_today: "planning",
  my_projects: "planning",
  critical_projects: "planning",
  absent_today: "planning",
  werkstatt_kpis: "werkstatt",
  werkstatt_reorder: "werkstatt",
  werkstatt_on_site: "werkstatt",
  werkstatt_my_checkouts: "werkstatt",
  werkstatt_boxes: "werkstatt",
  werkstatt_inspections: "werkstatt",
  recent_panels: "werkstatt",
  recent_reports: "office",
  vacation_approvals: "office",
  clocked_in: "office",
  unread_chats: "office",
};

describe("dashboard ids", () => {
  it("lists the 20 catalog widgets in catalog order", () => {
    expect([...DASHBOARD_WIDGET_IDS]).toEqual(Object.keys(GROUP_OF));
  });

  it("lists the 14 shortcut tiles, without the retired materials view", () => {
    expect([...DASHBOARD_SHORTCUT_VIEWS]).toEqual([
      "my_tasks",
      "planning",
      "calendar",
      "construction",
      "reports",
      "schaltplan",
      "werkstatt",
      "messages",
      "time",
      "wiki",
      "projects_all",
      "projects_map",
      "customers",
      "ausbildung",
    ]);
    expect(DASHBOARD_MAX_SHORTCUT_VIEWS).toBe(12);
  });

  it("knows three devices and three sizes", () => {
    expect([...DASHBOARD_DEVICES]).toEqual(["mobile", "tablet", "desktop"]);
    expect([...DASHBOARD_WIDGET_SIZES]).toEqual(["small", "medium", "large"]);
  });
});

describe("DASHBOARD_WIDGET_META", () => {
  it("has an entry for exactly the catalog ids, each in its catalog group", () => {
    expect(Object.keys(DASHBOARD_WIDGET_META).sort()).toEqual([...DASHBOARD_WIDGET_IDS].sort());
    for (const id of DASHBOARD_WIDGET_IDS) {
      expect(DASHBOARD_WIDGET_META[id].id).toBe(id);
      expect(DASHBOARD_WIDGET_META[id].group).toBe(GROUP_OF[id]);
    }
  });

  it("gives every widget a German and an English title and description", () => {
    for (const id of DASHBOARD_WIDGET_IDS) {
      const meta = DASHBOARD_WIDGET_META[id];
      expect(meta.title.de.trim(), id).not.toBe("");
      expect(meta.title.en.trim(), id).not.toBe("");
      expect(meta.description.de.trim(), id).not.toBe("");
      expect(meta.description.en.trim(), id).not.toBe("");
    }
  });

  it("uses the titles from the contract", () => {
    expect(DASHBOARD_WIDGET_META.planning_today.title.de).toBe("Mein Einsatz");
    expect(DASHBOARD_WIDGET_META.absent_today.title.de).toBe("Wer fehlt heute");
    expect(DASHBOARD_WIDGET_META.recent_panels.title.de).toBe("Zuletzt bearbeitete Verteiler");
    expect(DASHBOARD_WIDGET_META.werkstatt_inspections.description.de).toBe("Prüfungen der nächsten 30 Tage.");
  });
});

describe("DASHBOARD_POLL_MS", () => {
  it("matches the refresh column of the catalog", () => {
    expect(DASHBOARD_POLL_MS).toEqual({
      timeCurrent: 30_000,
      clockSummary: 60_000,
      recentReports: 60_000,
      werkstatt: 120_000,
      vacationPending: 120_000,
      slow: 600_000,
    });
  });
});
