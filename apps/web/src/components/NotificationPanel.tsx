/**
 * NotificationPanel — slide-in panel showing recent personal notifications.
 *
 * Rendered inside the sidebar when the bell button is clicked.
 * Marks all as read when the panel is opened.
 */
import { useEffect } from "react";

export type AppNotification = {
  id: number;
  event_type: string;
  entity_type: string;
  entity_id: number | null;
  project_id: number | null;
  message: string;
  read_at: string | null;
  created_at: string;
  actor_name: string | null;
};

type Props = {
  notifications: AppNotification[];
  language: "de" | "en";
  onMarkAllRead: () => void;
  onDismiss: () => void;
  onNavigate: (notif: AppNotification) => void;
};

function formatAge(isoString: string, language: "de" | "en"): string {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (language === "de") {
    if (mins < 1) return "gerade eben";
    if (mins < 60) return `vor ${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `vor ${hours}h`;
    return `vor ${Math.floor(hours / 24)}d`;
  }
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function NotificationPanel({
  notifications,
  language,
  onMarkAllRead,
  onDismiss,
  onNavigate,
}: Props) {
  const unreadCount = notifications.filter((n) => n.read_at === null).length;

  // Auto-mark-all-read when panel opens.
  useEffect(() => {
    if (unreadCount > 0) {
      onMarkAllRead();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const title = language === "de" ? "Benachrichtigungen" : "Notifications";
  const emptyText = language === "de" ? "Keine Benachrichtigungen" : "No notifications";
  const closeLabel = language === "de" ? "Schließen" : "Close";

  return (
    <div className="notification-panel" role="dialog" aria-label={title}>
      <div className="notification-panel-header">
        <span className="notification-panel-title">{title}</span>
        <button
          type="button"
          className="notification-panel-close"
          onClick={onDismiss}
          aria-label={closeLabel}
        >
          ✕
        </button>
      </div>

      {notifications.length === 0 ? (
        <p className="notification-panel-empty">{emptyText}</p>
      ) : (
        <ul className="notification-list">
          {notifications.map((n) => (
            <li
              key={n.id}
              className={`notification-item${n.read_at === null ? " notification-item--unread" : ""}`}
              onClick={() => onNavigate(n)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => event.key === "Enter" && onNavigate(n)}
            >
              <span className="notification-message">{n.message}</span>
              <time
                className="notification-age"
                dateTime={n.created_at}
                title={new Date(n.created_at).toLocaleString()}
              >
                {formatAge(n.created_at, language)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
