import { useCallback } from "react";

import { useAppContext } from "../../../../context/AppContext";
import { useDashboardNavigation } from "../../../../hooks/useDashboardNavigation";
import type { Language } from "../../../../types";
import type { AppNotification } from "../../../NotificationPanel";
import { DashboardWidgetFrame } from "../../DashboardWidgetFrame";
import { DASHBOARD_WIDGET_META } from "../../widgetMeta";
import type { DashboardWidgetProps } from "../../widgetTypes";
import { limitRows, localeOf } from "./widgetShared";
import "./personal.css";

/**
 * „Benachrichtigungen“: the newest notices for the user (docs/DASHBOARD.md
 * §1, §1.1). Context-fed — App keeps `notifications` current over SSE — so
 * the widget never polls. The count is the unread ones; „Alle gelesen“
 * (Mittel and Groß) clears them the way the bell's panel does.
 *
 * A task notice opens the task list (the office one in Büro mode), as the
 * bell's panel does. The rows past the size's limit live in that panel, so
 * „+n weitere“ opens it — with the sidebar, which holds the bell on phones.
 */
function ageLabel(createdAt: string, language: Language, nowMs: number): string {
  const created = new Date(createdAt).getTime();
  const de = language === "de";
  if (Number.isNaN(created)) return "";
  const minutes = Math.max(0, Math.floor((nowMs - created) / 60_000));
  if (minutes < 1) return de ? "gerade eben" : "just now";
  if (minutes < 60) return de ? `vor ${minutes} min` : `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return de ? `vor ${hours} h` : `${hours} h ago`;
  return new Date(created).toLocaleDateString(localeOf(language), { day: "2-digit", month: "2-digit" });
}

function NotificationContent({ row, language, nowMs }: { row: AppNotification; language: Language; nowMs: number }) {
  return (
    <>
      <span className="dw-notifications__dot" aria-hidden="true" />
      <span className="dw-notifications__message">{row.message}</span>
      <time className="dw-notifications__age" dateTime={row.created_at}>
        {ageLabel(row.created_at, language, nowMs)}
      </time>
    </>
  );
}

export default function NotificationsWidget({ size }: DashboardWidgetProps) {
  const {
    language,
    now,
    notifications,
    markAllNotificationsRead,
    setMyTasksBackProjectId,
    setNotifPanelOpen,
    setSidebarOpen,
  } = useAppContext();
  const { open } = useDashboardNavigation();

  const openPanel = useCallback(() => {
    setSidebarOpen(true);
    setNotifPanelOpen(true);
  }, [setSidebarOpen, setNotifPanelOpen]);

  const openTask = useCallback(() => {
    setMyTasksBackProjectId(null);
    open({ kind: "view", view: "my_tasks" });
  }, [open, setMyTasksBackProjectId]);

  const de = language === "de";
  const rows = notifications ?? [];
  const unread = rows.filter((row) => row.read_at === null).length;
  const { visible, more } = limitRows(rows, size);
  // The context's clock (it ticks every second), so ages move without a poll.
  const nowMs = now.getTime();

  return (
    <DashboardWidgetFrame
      title={DASHBOARD_WIDGET_META.notifications.title[language]}
      badge={unread}
      action={
        size !== "small" && unread > 0
          ? { label: de ? "Alle gelesen" : "Mark all read", onClick: () => void markAllNotificationsRead() }
          : null
      }
      isEmpty={rows.length === 0}
      emptyText={de ? "Keine Benachrichtigungen." : "No notifications."}
      more={{ count: more, onClick: openPanel }}
    >
      <ul className="dw-notifications__list">
        {visible.map((row) => {
          const className = `dw-notifications__row${row.read_at === null ? " dw-notifications__row--unread" : ""}`;
          return (
            <li key={row.id} className="dw-notifications__item">
              {row.entity_type === "task" ? (
                <button type="button" className={className} onClick={openTask}>
                  <NotificationContent row={row} language={language} nowMs={nowMs} />
                </button>
              ) : (
                <div className={className}>
                  <NotificationContent row={row} language={language} nowMs={nowMs} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </DashboardWidgetFrame>
  );
}
