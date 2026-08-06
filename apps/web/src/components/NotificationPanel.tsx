/**
 * NotificationPanel — slide-in panel showing recent personal notifications.
 *
 * Rendered inside the sidebar when the bell button is clicked.
 *
 * The panel owns the list it displays instead of rendering the app-level array
 * straight through, for two reasons the bug report named:
 *
 *  1. Clicking an entry has to make it disappear. That means a persisted
 *     dismissal (PATCH /notifications/{id}/dismiss) — an entry removed only
 *     from a local array reappears on the next refresh.
 *  2. The app-level array is only refetched when a *new* notification arrives
 *     over SSE, so an entry whose task was completed in the meantime lingered
 *     until a full page reload. The panel therefore refetches when it opens.
 *
 * A failed dismiss is never swallowed: the entry stays put and the panel shows
 * why, so nobody walks away believing it worked.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiFetch } from "../api/client";
import { useAppContext } from "../context/AppContext";

export type AppNotification = {
  id: number;
  event_type: string;
  entity_type: string;
  entity_id: number | null;
  project_id: number | null;
  message: string;
  read_at: string | null;
  dismissed_at?: string | null;
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

const MAX_VISIBLE = 20;

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

/** Reason string for an inline panel error, without leaking stack traces. */
function describeError(error: unknown): string | null {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return null;
}

function dismissFailedText(error: unknown, language: "de" | "en"): string {
  const base =
    language === "de"
      ? "Benachrichtigung konnte nicht entfernt werden."
      : "Could not dismiss this notification.";
  const reason = describeError(error);
  return reason ? `${base} (${reason})` : base;
}

function refreshFailedText(error: unknown, language: "de" | "en"): string {
  const base =
    language === "de"
      ? "Benachrichtigungen konnten nicht aktualisiert werden — die Liste ist möglicherweise veraltet."
      : "Could not refresh notifications — this list may be out of date.";
  const reason = describeError(error);
  return reason ? `${base} (${reason})` : base;
}

export function NotificationPanel({
  notifications,
  language,
  onMarkAllRead,
  onDismiss,
  onNavigate,
}: Props) {
  const { token } = useAppContext();

  // Ids dismissed during this panel session. The app-level array is refreshed
  // independently of us, and until it is refetched it still contains entries
  // the server has already dismissed — without this guard they would pop back
  // into the list on the next re-render.
  const dismissedIdsRef = useRef<Set<number>>(new Set());
  const [items, setItems] = useState<AppNotification[]>(notifications);
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const adopt = useCallback((rows: AppNotification[]) => {
    setItems(rows.filter((row) => !dismissedIdsRef.current.has(row.id)));
  }, []);

  // Follow app-level updates (SSE refresh, mark-all-read) while open.
  useEffect(() => {
    adopt(notifications);
  }, [adopt, notifications]);

  // Refetch on open. The server drops entries that are dismissed or whose task
  // is already done, which is what clears stale notifications from the panel.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    async function refresh(authToken: string) {
      try {
        const fresh = await apiFetch<AppNotification[]>("/notifications", authToken);
        if (cancelled) return;
        adopt(fresh);
      } catch (error) {
        if (cancelled) return;
        setErrorText(refreshFailedText(error, language));
      }
    }
    void refresh(token);
    return () => {
      cancelled = true;
    };
    // Runs once per panel opening — the component only exists while open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Auto-mark-all-read once per panel opening: clears the bell badge. Read is
  // not dismissed — the entries stay listed until the user clicks them. The
  // ref (rather than a mount-only effect) covers the case where the first
  // unread entry only arrives with the refetch above; anything that lands
  // afterwards stays highlighted, which is the point of a new notification.
  const markedReadRef = useRef(false);
  useEffect(() => {
    if (markedReadRef.current) return;
    if (!items.some((n) => n.read_at === null)) return;
    markedReadRef.current = true;
    onMarkAllRead();
  }, [items, onMarkAllRead]);

  async function handleActivate(notif: AppNotification) {
    if (pendingId !== null) return;
    setPendingId(notif.id);
    setErrorText(null);
    try {
      await apiFetch<AppNotification>(`/notifications/${notif.id}/dismiss`, token, {
        method: "PATCH",
      });
    } catch (error) {
      // 404 means the row is already gone server-side (task deleted, or a
      // dismiss that landed twice) — the entry should disappear either way.
      // Anything else is a real failure: keep the entry and say so.
      if (!(error instanceof ApiError && error.status === 404)) {
        setPendingId(null);
        setErrorText(dismissFailedText(error, language));
        return;
      }
    }
    dismissedIdsRef.current = new Set([...dismissedIdsRef.current, notif.id]);
    setItems((current) => current.filter((entry) => entry.id !== notif.id));
    setPendingId(null);
    onNavigate(notif);
  }

  const visibleNotifications = items.slice(0, MAX_VISIBLE);
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

      {errorText && (
        <p className="notification-panel-error" role="alert">
          {errorText}
        </p>
      )}

      {items.length === 0 ? (
        <p className="notification-panel-empty">{emptyText}</p>
      ) : (
        <>
          <ul className="notification-list">
            {visibleNotifications.map((n) => (
            <li
              key={n.id}
              className={`notification-item${n.read_at === null ? " notification-item--unread" : ""}`}
              onClick={() => void handleActivate(n)}
              role="button"
              tabIndex={0}
              aria-busy={pendingId === n.id}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                void handleActivate(n);
              }}
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
          {items.length > visibleNotifications.length && (
            <p className="notification-panel-empty" style={{ paddingTop: 0 }}>
              {language === "de"
                ? `Es werden die letzten ${visibleNotifications.length} Benachrichtigungen angezeigt.`
                : `Showing the latest ${visibleNotifications.length} notifications.`}
            </p>
          )}
        </>
      )}
    </div>
  );
}
