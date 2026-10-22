import { useMemo } from "react";

import { useAppContext } from "../../../../context/AppContext";
import type { Project } from "../../../../types";
import { parseServerDateTime } from "../../../../utils/dates";
import { isArchivedProjectStatus } from "../../../../utils/projects";
import { DashboardWidgetFrame } from "../../DashboardWidgetFrame";
import { DASHBOARD_WIDGET_META } from "../../widgetMeta";
import type { DashboardWidgetProps } from "../../widgetTypes";
import { limitRows, localeOf, useFullPageLink } from "../personal/widgetShared";
import { ProjectRows } from "./ProjectRows";
import "./planning.css";

/**
 * „Kritische Projekte“: projects someone marked as critical (docs/
 * DASHBOARD.md §1), from the context's `projects` — no request of its own.
 * Archived ones are left out: an archived project needs nobody's attention.
 * The most recently flagged comes first, since that is the news.
 */
function criticalSinceMs(project: Project): number | null {
  return parseServerDateTime(project.critical_since)?.getTime() ?? null;
}

function byNewestFlag(left: Project, right: Project): number {
  const leftSince = criticalSinceMs(left);
  const rightSince = criticalSinceMs(right);
  if (leftSince !== rightSince) {
    if (leftSince === null) return 1;
    if (rightSince === null) return -1;
    return rightSince - leftSince;
  }
  return left.id - right.id;
}

export default function CriticalProjectsWidget({ size }: DashboardWidgetProps) {
  const { language, projects } = useAppContext();
  const openAll = useFullPageLink("projects_all");
  const critical = useMemo(
    () =>
      (projects ?? [])
        .filter((project) => project.is_critical && !isArchivedProjectStatus(project.status))
        .sort(byNewestFlag),
    [projects],
  );

  const de = language === "de";
  const { visible, more } = limitRows(critical, size);

  function since(project: Project) {
    const flagged = parseServerDateTime(project.critical_since);
    if (!flagged) return null;
    const day = flagged.toLocaleDateString(localeOf(language), { day: "2-digit", month: "2-digit" });
    return de ? `seit ${day}` : `since ${day}`;
  }

  return (
    <DashboardWidgetFrame
      title={DASHBOARD_WIDGET_META.critical_projects.title[language]}
      badge={critical.length}
      action={openAll ? { label: de ? "Alle anzeigen" : "Show all", onClick: openAll } : null}
      isEmpty={critical.length === 0}
      emptyText={de ? "Keine kritischen Projekte." : "No critical projects."}
      more={openAll ? { count: more, onClick: openAll } : null}
    >
      <ProjectRows projects={visible} aside={since} />
    </DashboardWidgetFrame>
  );
}
