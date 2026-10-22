/**
 * Where a start-page tile, row or link takes you (docs/DASHBOARD.md §9.5).
 *
 * Widgets never call setMainView themselves. Going through one hook keeps
 * three things true everywhere: the back button the old shortcut cards set up
 * still appears, „Meine Aufgaben“ lands on the office task list in Büro mode,
 * and a tile never offers a page the sidebar hides in the current mode.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

import { AppContext, type AppContextValue } from "../context/AppContext";
import { useDashboardNavigation } from "../hooks/useDashboardNavigation";
import { clearPendingPanel, peekPendingPanel } from "../utils/schaltplanHandoff";
import type { MainView, WorkspaceMode } from "../types";
import type { PanelPlanSummary } from "../types/schaltplan";
import { makeAppContextStub } from "./appContextStub";

const CONSTRUCTION_NAV: MainView[] = ["overview", "my_tasks", "planning", "construction", "schaltplan", "werkstatt", "messages", "time", "wiki"];
const OFFICE_NAV: MainView[] = ["overview", "office_tasks", "projects_all", "projects_map", "customers", "planning", "werkstatt", "messages", "time", "wiki"];

const PANEL = {
  id: 42,
  panel_number: "VT-0042",
  customer_id: 3,
  customer_name: "Beispiel GmbH",
  name: "UV Keller",
  designation: "UV1",
} as PanelPlanSummary;

function setup(workspaceMode: WorkspaceMode) {
  const calls: string[] = [];
  const record = (name: string) => vi.fn((...args: unknown[]) => calls.push(`${name}(${args.map((arg) => JSON.stringify(arg)).join(",")})`));
  const spies = {
    setProjectBackView: record("setProjectBackView"),
    setOverviewShortcutBackVisible: record("setOverviewShortcutBackVisible"),
    setConstructionBackView: record("setConstructionBackView"),
    setMainView: record("setMainView"),
    setWerkstattTab: record("setWerkstattTab"),
    openProjectById: record("openProjectById"),
    setActiveThreadId: record("setActiveThreadId"),
  };
  const context = makeAppContextStub({
    overrides: {
      workspaceMode,
      navViews: workspaceMode === "office" ? OFFICE_NAV : CONSTRUCTION_NAV,
      ...spies,
    },
  }) as AppContextValue;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AppContext.Provider value={context}>{children}</AppContext.Provider>
  );
  const { result } = renderHook(() => useDashboardNavigation(), { wrapper });
  return { calls, navigation: result.current };
}

const SHORTCUT_SEQUENCE = [
  "setProjectBackView(null)",
  "setOverviewShortcutBackVisible(true)",
  "setConstructionBackView(null)",
];

afterEach(() => clearPendingPanel());

describe("resolveView", () => {
  it("maps „Meine Aufgaben“ to the office task list in Büro mode", () => {
    expect(setup("construction").navigation.resolveView("my_tasks")).toBe("my_tasks");
    expect(setup("office").navigation.resolveView("my_tasks")).toBe("office_tasks");
  });

  it("returns null for a view the sidebar hides in the current mode", () => {
    const construction = setup("construction").navigation;
    const office = setup("office").navigation;

    expect(construction.resolveView("projects_map")).toBeNull();
    expect(office.resolveView("schaltplan")).toBeNull();
    expect(office.resolveView("ausbildung")).toBeNull();
    expect(construction.resolveView("ausbildung")).toBeNull();
    expect(office.resolveView("projects_map")).toBe("projects_map");
    expect(construction.resolveView("werkstatt")).toBe("werkstatt");
  });
});

describe("open", () => {
  it("runs the shortcut sequence before a plain view", () => {
    const { calls, navigation } = setup("construction");

    navigation.open({ kind: "view", view: "time" });

    expect(calls).toEqual([...SHORTCUT_SEQUENCE, 'setMainView("time")']);
  });

  it("opens the office task list for „my_tasks“ in Büro mode", () => {
    const { calls, navigation } = setup("office");

    navigation.open({ kind: "view", view: "my_tasks" });

    expect(calls[calls.length - 1]).toBe('setMainView("office_tasks")');
  });

  it("opens a Werkstatt tab", () => {
    const { calls, navigation } = setup("office");

    navigation.open({ kind: "werkstatt", tab: "nachbestellen" });

    expect(calls).toEqual([...SHORTCUT_SEQUENCE, 'setWerkstattTab("nachbestellen")', 'setMainView("werkstatt")']);
  });

  it("opens a project without a back view", () => {
    const { calls, navigation } = setup("construction");

    navigation.open({ kind: "project", projectId: 17 });

    expect(calls).toEqual([...SHORTCUT_SEQUENCE, "openProjectById(17,null)"]);
  });

  it("opens a chat thread in Nachrichten", () => {
    const { calls, navigation } = setup("office");

    navigation.open({ kind: "thread", threadId: 5 });

    expect(calls).toEqual([...SHORTCUT_SEQUENCE, "setActiveThreadId(5)", 'setMainView("messages")']);
  });

  it("hands a Verteiler to the Schaltplan editor in Baustelle mode", () => {
    const { calls, navigation } = setup("construction");

    navigation.open({ kind: "panel", panel: PANEL });

    expect(calls).toEqual([...SHORTCUT_SEQUENCE, 'setMainView("schaltplan")']);
    expect(peekPendingPanel()).toEqual(PANEL);
  });

  it("opens the Kommissionierung for a Verteiler in Büro mode, with no handoff", () => {
    const { calls, navigation } = setup("office");

    navigation.open({ kind: "panel", panel: PANEL });

    expect(calls).toEqual([...SHORTCUT_SEQUENCE, 'setWerkstattTab("verteiler")', 'setMainView("werkstatt")']);
    expect(peekPendingPanel()).toBeNull();
  });
});
