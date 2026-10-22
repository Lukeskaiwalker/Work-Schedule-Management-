/**
 * Loaders of the „Persönlich“ widgets: my_status, my_tasks, my_vacation,
 * notifications (docs/DASHBOARD.md §1; part W3).
 *
 * Loaders only, never components or CSS: this file is imported by the
 * registry on every visit, the widgets are not (D24). Each widget imports
 * `./personal.css` itself so the styles ride in its lazy chunk.
 */
import type { DashboardWidgetLoaders } from "../../widgetTypes";

export const PERSONAL_WIDGET_LOADERS: DashboardWidgetLoaders = {
  my_status: () => import("./MyStatusWidget"),
  my_tasks: () => import("./MyTasksWidget"),
  my_vacation: () => import("./MyVacationWidget"),
  notifications: () => import("./NotificationsWidget"),
};
