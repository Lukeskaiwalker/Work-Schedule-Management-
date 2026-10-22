import { useMemo } from "react";

import { useAppContext } from "../../../../context/AppContext";
import { useDashboardNavigation } from "../../../../hooks/useDashboardNavigation";
import type { Thread } from "../../../../types";
import { parseServerDateTime } from "../../../../utils/dates";
import { DashboardWidgetFrame } from "../../DashboardWidgetFrame";
import { DASHBOARD_WIDGET_META } from "../../widgetMeta";
import type { DashboardWidgetProps } from "../../widgetTypes";
import { limitRows, useFullPageLink } from "./officeShared";
import "./office.css";

function lastMessageTime(thread: Thread): number {
  return parseServerDateTime(thread.last_message_at)?.getTime() ?? 0;
}

/** Chats with something new, the most recent conversation first. */
function unreadNewestFirst(threads: readonly Thread[]): Thread[] {
  return threads
    .filter((thread) => Number(thread.unread_count) > 0)
    .sort((a, b) => lastMessageTime(b) - lastMessageTime(a) || b.id - a.id);
}

/**
 * „Ungelesene Chats“: the chats with unread messages (docs/DASHBOARD.md §1).
 * It reads the app's chat list, which App already refreshes every 12 s and on
 * chat events, so the widget makes no request of its own. The header count is
 * the number of chats; each row carries that chat's unread messages.
 */
export default function UnreadChatsWidget({ size }: DashboardWidgetProps) {
  const { language, threads, threadProjectTitleParts } = useAppContext();
  const { open } = useDashboardNavigation();
  const openAll = useFullPageLink("messages");
  // The context is rebuilt every second (its clock); sort only when the
  // chat list itself changes.
  const unread = useMemo(() => unreadNewestFirst(threads), [threads]);

  const de = language === "de";
  const { visible, more } = limitRows(unread, size);

  return (
    <DashboardWidgetFrame
      title={DASHBOARD_WIDGET_META.unread_chats.title[language]}
      badge={unread.length}
      action={openAll ? { label: de ? "Alle anzeigen" : "Show all", onClick: openAll } : null}
      isEmpty={unread.length === 0}
      emptyText={de ? "Keine ungelesenen Nachrichten." : "No unread messages."}
      more={openAll ? { count: more, onClick: openAll } : null}
    >
      <ul className="dashboard-office__list">
        {visible.map((thread) => {
          const detail = thread.last_message_preview?.trim() || threadProjectTitleParts(thread).title;
          return (
            <li key={thread.id} className="dashboard-office__row">
              <button
                type="button"
                className="dashboard-office__row-button"
                onClick={() => open({ kind: "thread", threadId: thread.id })}
              >
                <span className="dashboard-office__main">
                  <span className="dashboard-office__primary">{thread.name}</span>
                  {detail ? <span className="dashboard-office__secondary dashboard-office__clip">{detail}</span> : null}
                </span>
                <span className="dashboard-office__count" aria-hidden="true">
                  {thread.unread_count}
                </span>
                <span className="visually-hidden">
                  {de ? `${thread.unread_count} ungelesen` : `${thread.unread_count} unread`}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </DashboardWidgetFrame>
  );
}
