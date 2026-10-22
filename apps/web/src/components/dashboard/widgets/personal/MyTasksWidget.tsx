import { useCallback } from "react";

import { useAppContext } from "../../../../context/AppContext";
import { useDashboardNavigation } from "../../../../hooks/useDashboardNavigation";
import { DASHBOARD_ROW_LIMIT } from "../../../../utils/dashboardLayout";
import { MyTasksOverviewCard } from "../../../tasks/MyTasksOverviewCard";
import { DashboardWidgetFrame } from "../../DashboardWidgetFrame";
import { DASHBOARD_WIDGET_META } from "../../widgetMeta";
import type { DashboardWidgetProps } from "../../widgetTypes";
import { useFullPageLink } from "./widgetShared";
import "./personal.css";

/**
 * „Meine Aufgaben“: the overview's task card inside a start-page frame
 * (docs/DASHBOARD.md §1.1): 3 rows without the status filter at Klein, 5 or
 * 10 with it at Mittel and Groß. Context-fed (`tasks`, view `my_all`, which
 * App loads on the overview), so it never polls.
 *
 * The card keeps its own ordering, filter, row actions and „+n weitere“; the
 * way to the full list comes from useDashboardNavigation, so in Büro mode
 * rows and links land on the office task list rather than on a page the
 * sidebar hides there.
 */
export default function MyTasksWidget({ size }: DashboardWidgetProps) {
  const { language } = useAppContext();
  const { open } = useDashboardNavigation();
  const showAll = useFullPageLink("my_tasks");
  // Rows navigate even when the header link is hidden, as the card always did.
  const openList = useCallback(() => open({ kind: "view", view: "my_tasks" }), [open]);

  return (
    <DashboardWidgetFrame
      title={DASHBOARD_WIDGET_META.my_tasks.title[language]}
      action={showAll ? { label: language === "de" ? "Alle anzeigen" : "Show all", onClick: showAll } : null}
    >
      <MyTasksOverviewCard
        embedded
        rowLimit={DASHBOARD_ROW_LIMIT[size]}
        showFilter={size !== "small"}
        onOpenList={openList}
      />
    </DashboardWidgetFrame>
  );
}
