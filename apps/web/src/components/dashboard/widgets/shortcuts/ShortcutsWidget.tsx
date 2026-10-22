import { useCallback, useMemo } from "react";

import { useAppContext } from "../../../../context/AppContext";
import { useDashboardNavigation } from "../../../../hooks/useDashboardNavigation";
import type { DashboardShortcutView } from "../../../../types/dashboard";
import { SidebarNavIcon } from "../../../icons";
import { DashboardWidgetFrame } from "../../DashboardWidgetFrame";
import { DASHBOARD_WIDGET_META } from "../../widgetMeta";
import type { DashboardWidgetProps } from "../../widgetTypes";
import {
  SHORTCUT_TILES,
  countOpenOwnTasks,
  sumUnreadMessages,
  visibleShortcutViews,
  type ShortcutBadge,
} from "./shortcutTiles";
import "./shortcuts.css";

/**
 * „Schnellzugriff“: tiles to the user's most used pages (docs/DASHBOARD.md
 * §1, §1.1). Fed from the app context alone — tasks and chats are already
 * loaded and refreshed by App — so it makes no request and never polls.
 *
 * Klein is a compact list, one tile per line; Mittel and Groß are a tile grid
 * that fills the card. Which tiles show follows the sidebar (resolveView), so
 * switching between Baustelle and Büro never leaves a tile to a hidden page.
 */
export default function ShortcutsWidget({ size, settings, device }: DashboardWidgetProps) {
  const { language, user, tasks, threads, workspaceMode } = useAppContext();
  const { open, resolveView } = useDashboardNavigation();
  const userId = user?.id ?? null;

  const isOffered = useCallback((view: DashboardShortcutView) => resolveView(view) !== null, [resolveView]);
  const views = useMemo(
    () => visibleShortcutViews(settings, workspaceMode, device, isOffered),
    [settings, workspaceMode, device, isOffered],
  );
  // The context is rebuilt every second (its clock); count only when the
  // lists themselves change.
  const openTasks = useMemo(() => countOpenOwnTasks(tasks, userId), [tasks, userId]);
  const unreadMessages = useMemo(() => sumUnreadMessages(threads), [threads]);

  const de = language === "de";
  const compact = size === "small";

  function badgeOf(kind: ShortcutBadge | null): { count: number; noun: string } | null {
    if (kind === "open_own_tasks" && openTasks > 0) return { count: openTasks, noun: de ? "offen" : "open" };
    if (kind === "unread_messages" && unreadMessages > 0) {
      return { count: unreadMessages, noun: de ? "ungelesen" : "unread" };
    }
    return null;
  }

  return (
    <DashboardWidgetFrame title={DASHBOARD_WIDGET_META.shortcuts.title[language]}>
      <ul className={`dashboard-shortcuts ${compact ? "dashboard-shortcuts--list" : "dashboard-shortcuts--grid"}`}>
        {views.map((view) => {
          const tile = SHORTCUT_TILES[view];
          const label = tile.label[language];
          const badge = badgeOf(tile.badge);
          return (
            <li key={view} className="dashboard-shortcuts__cell">
              <button
                type="button"
                className={compact ? "dashboard-shortcuts__item" : "dashboard-shortcuts__tile"}
                // The count alone („3“) says nothing to a screen reader.
                aria-label={badge ? `${label}, ${badge.count} ${badge.noun}` : undefined}
                onClick={() => open({ kind: "view", view })}
              >
                <span className="dashboard-shortcuts__icon" aria-hidden="true">
                  <SidebarNavIcon view={view} />
                </span>
                <span className="dashboard-shortcuts__label">{label}</span>
                {badge ? (
                  <span className="dashboard-shortcuts__badge" aria-hidden="true">
                    {badge.count}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </DashboardWidgetFrame>
  );
}
