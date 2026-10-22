/**
 * Loaders of the „Büro“ widgets: recent_reports, vacation_approvals,
 * clocked_in, unread_chats (docs/DASHBOARD.md §1; part W5).
 *
 * Loaders only, never components or CSS: this file is imported by the
 * registry on every visit, the widgets are not (D24). Each widget imports
 * `./office.css` itself so the styles ride in its lazy chunk.
 */
import type { DashboardWidgetLoaders } from "../../widgetTypes";

export const OFFICE_WIDGET_LOADERS: DashboardWidgetLoaders = {
  recent_reports: () => import("./RecentReportsWidget"),
  vacation_approvals: () => import("./VacationApprovalsWidget"),
  clocked_in: () => import("./ClockedInWidget"),
  unread_chats: () => import("./UnreadChatsWidget"),
};
