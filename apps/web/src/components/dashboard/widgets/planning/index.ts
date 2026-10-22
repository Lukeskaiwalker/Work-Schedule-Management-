/**
 * Loaders of the „Planung & Projekte“ widgets: planning_today, my_projects,
 * critical_projects, absent_today (docs/DASHBOARD.md §1; part W3).
 *
 * Loaders only, never components or CSS: this file is imported by the
 * registry on every visit, the widgets are not (D24). Each widget imports
 * `./planning.css` itself so the styles ride in its lazy chunk.
 */
import type { DashboardWidgetLoaders } from "../../widgetTypes";

export const PLANNING_WIDGET_LOADERS: DashboardWidgetLoaders = {
  planning_today: () => import("./PlanningTodayWidget"),
  my_projects: () => import("./MyProjectsWidget"),
  critical_projects: () => import("./CriticalProjectsWidget"),
  absent_today: () => import("./AbsentTodayWidget"),
};
