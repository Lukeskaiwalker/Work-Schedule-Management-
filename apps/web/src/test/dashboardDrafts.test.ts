/**
 * Unsaved start-page drafts (docs/DASHBOARD.md §8.2).
 *
 * Navigation runs through the sidebar, the drawer and the bottom bar, none of
 * which the start page controls, so leaving it while editing cannot be
 * stopped — the draft is kept in memory instead and reopened on return. Two
 * things matter: a read must not consume it (React.StrictMode renders twice,
 * main.tsx), and a shared workshop tablet must not hand one person's draft to
 * the next (cleared when the session ends).
 */
import { afterEach, describe, expect, it } from "vitest";

import { clearDraft, rememberDraft, takeDraft } from "../utils/dashboardDrafts";
import { endDashboardSession } from "../utils/dashboardSession";
import type { DashboardWidgetItem } from "../types/dashboard";

const DRAFT: DashboardWidgetItem[] = [
  { id: "shortcuts", size: "large", settings: { views: ["planning", "time"] } },
  { id: "my_tasks", size: "small" },
];

afterEach(() => endDashboardSession());

describe("dashboard drafts", () => {
  it("returns a copy of what was remembered, and a second read still finds it", () => {
    rememberDraft(7, "tablet", DRAFT);
    const first = takeDraft(7, "tablet");
    expect(first).toEqual(DRAFT);
    expect(first).not.toBe(DRAFT);
    expect(takeDraft(7, "tablet")).toEqual(DRAFT);
  });

  it("keeps drafts apart per user and per device", () => {
    rememberDraft(7, "tablet", DRAFT);
    expect(takeDraft(7, "desktop")).toBeNull();
    expect(takeDraft(8, "tablet")).toBeNull();
  });

  it("is not changed by later edits to the array it was given or returned", () => {
    const given = structuredClone(DRAFT);
    rememberDraft(7, "mobile", given);
    given.pop();
    const read = takeDraft(7, "mobile");
    read?.pop();
    expect(takeDraft(7, "mobile")).toEqual(DRAFT);
  });

  it("clearDraft drops one device only", () => {
    rememberDraft(7, "mobile", DRAFT);
    rememberDraft(7, "desktop", DRAFT);
    clearDraft(7, "mobile");
    expect(takeDraft(7, "mobile")).toBeNull();
    expect(takeDraft(7, "desktop")).toEqual(DRAFT);
  });

  it("forgets every draft when the session ends", () => {
    rememberDraft(7, "mobile", DRAFT);
    rememberDraft(8, "desktop", DRAFT);
    endDashboardSession();
    expect(takeDraft(7, "mobile")).toBeNull();
    expect(takeDraft(8, "desktop")).toBeNull();
  });
});
