import { useCallback, useMemo } from "react";

import { useAppContext } from "../context/AppContext";
import type { MainView, WerkstattTab, WorkspaceMode } from "../types";
import type { PanelPlanSummary } from "../types/schaltplan";
import { requestOpenPanel } from "../utils/schaltplanHandoff";

/**
 * Where a start-page tile, row or link goes (docs/DASHBOARD.md §9.5).
 *
 * Widgets never call setMainView themselves, so three things hold everywhere:
 * the back button the old overview shortcuts set up still appears on the
 * pages that show it, „Meine Aufgaben“ lands on the office task list in Büro
 * mode, and `resolveView` lets a tile hide when the sidebar hides its page.
 */
export type DashboardTarget =
  | { kind: "view"; view: MainView }
  | { kind: "werkstatt"; tab: WerkstattTab }
  | { kind: "project"; projectId: number }
  | { kind: "thread"; threadId: number }
  | { kind: "panel"; panel: PanelPlanSummary };

/** The page a view means in the current mode: the personal task list is „office_tasks“ in Büro mode. */
function viewForMode(view: MainView, mode: WorkspaceMode): MainView {
  return view === "my_tasks" && mode === "office" ? "office_tasks" : view;
}

export function useDashboardNavigation(): {
  open: (target: DashboardTarget) => void;
  resolveView: (view: MainView) => MainView | null;
} {
  const {
    workspaceMode,
    navViews,
    setMainView,
    setProjectBackView,
    setOverviewShortcutBackVisible,
    setConstructionBackView,
    setWerkstattTab,
    openProjectById,
    setActiveThreadId,
  } = useAppContext();

  const resolveView = useCallback(
    (view: MainView): MainView | null => {
      const target = viewForMode(view, workspaceMode);
      return navViews.includes(target) ? target : null;
    },
    [workspaceMode, navViews],
  );

  const open = useCallback(
    (target: DashboardTarget) => {
      // Today's shortcut sequence: no stale back target from an earlier
      // detour, and the header's „Zurück“ to the overview on arrival.
      setProjectBackView(null);
      setOverviewShortcutBackVisible(true);
      setConstructionBackView(null);
      switch (target.kind) {
        case "view":
          setMainView(viewForMode(target.view, workspaceMode));
          return;
        case "werkstatt":
          setWerkstattTab(target.tab);
          setMainView("werkstatt");
          return;
        case "project":
          openProjectById(target.projectId, null);
          return;
        case "thread":
          setActiveThreadId(target.threadId);
          setMainView("messages");
          return;
        case "panel":
          // The editor is a Baustelle tool (hidden in Büro mode); the office
          // works a panel from the Kommissionierung instead.
          if (workspaceMode === "construction") {
            requestOpenPanel(target.panel);
            setMainView("schaltplan");
          } else {
            setWerkstattTab("verteiler");
            setMainView("werkstatt");
          }
          return;
      }
    },
    [
      workspaceMode,
      setMainView,
      setProjectBackView,
      setOverviewShortcutBackVisible,
      setConstructionBackView,
      setWerkstattTab,
      openProjectById,
      setActiveThreadId,
    ],
  );

  return useMemo(() => ({ open, resolveView }), [open, resolveView]);
}
