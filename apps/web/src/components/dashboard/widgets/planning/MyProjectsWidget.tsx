import { useAppContext } from "../../../../context/AppContext";
import { DashboardWidgetFrame } from "../../DashboardWidgetFrame";
import { DASHBOARD_WIDGET_META } from "../../widgetMeta";
import type { DashboardWidgetProps } from "../../widgetTypes";
import { limitRows, useFullPageLink } from "../personal/widgetShared";
import { ProjectRows } from "./ProjectRows";
import "./planning.css";

/**
 * „Meine Projekte“: projects with open tasks for the user (docs/DASHBOARD.md
 * §1). Context-fed from `recentAssignedProjects`, which App derives from the
 * overview's own tasks — on the Baustelle side the job being built first —
 * and caps at ten, the „Groß“ row limit. No request of its own.
 */
export default function MyProjectsWidget({ size }: DashboardWidgetProps) {
  const { language, recentAssignedProjects } = useAppContext();
  const openAll = useFullPageLink("projects_all");

  const de = language === "de";
  const projects = recentAssignedProjects ?? [];
  const { visible, more } = limitRows(projects, size);

  return (
    <DashboardWidgetFrame
      title={DASHBOARD_WIDGET_META.my_projects.title[language]}
      action={openAll ? { label: de ? "Alle anzeigen" : "Show all", onClick: openAll } : null}
      isEmpty={projects.length === 0}
      emptyText={de ? "Keine zugewiesenen Projekte." : "No assigned projects."}
      more={openAll ? { count: more, onClick: openAll } : null}
    >
      <ProjectRows projects={visible} showCriticalDot />
    </DashboardWidgetFrame>
  );
}
