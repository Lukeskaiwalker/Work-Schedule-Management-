/**
 * The „Schnellzugriff“ tiles: what each one is called, in which workspace
 * mode it exists, which badge it carries, and the presets a widget without a
 * choice shows (docs/DASHBOARD.md §1, §5).
 *
 * Pure, so the widget and its editor („Kacheln wählen“) agree on every rule
 * and the rules are testable without rendering. Whether a tile is shown at
 * all is not decided here: that is `resolveView` (useDashboardNavigation),
 * which follows the sidebar's `navViews`, so a tile never offers a page the
 * sidebar hides.
 */
import type { Task, Thread, WorkspaceMode } from "../../../../types";
import {
  DASHBOARD_MAX_SHORTCUT_VIEWS,
  type DashboardDevice,
  type DashboardShortcutView,
  type DashboardWidgetSettings,
} from "../../../../types/dashboard";
import { canonicalTaskStatus } from "../../../../utils/tasks";

type Text = { de: string; en: string };

/** Where the sidebar offers the page: both modes, or only one of them. */
export type ShortcutTileMode = "both" | "construction" | "office";

export type ShortcutBadge = "open_own_tasks" | "unread_messages";

export type ShortcutTile = {
  view: DashboardShortcutView;
  /** Short on purpose: it sits under an icon in a 96 px tile. */
  label: Text;
  mode: ShortcutTileMode;
  badge: ShortcutBadge | null;
};

function tile(view: DashboardShortcutView, label: Text, mode: ShortcutTileMode = "both", badge: ShortcutBadge | null = null): ShortcutTile {
  return { view, label, mode, badge };
}

export const SHORTCUT_TILES: Readonly<Record<DashboardShortcutView, ShortcutTile>> = Object.freeze({
  // „Meine Aufgaben“ exists in both modes: Büro mode opens the office task
  // list instead (useDashboardNavigation), so the tile keeps its name.
  my_tasks: tile("my_tasks", { de: "Meine Aufgaben", en: "My tasks" }, "both", "open_own_tasks"),
  planning: tile("planning", { de: "Planung", en: "Planning" }),
  calendar: tile("calendar", { de: "Kalender", en: "Calendar" }),
  construction: tile("construction", { de: "Bericht", en: "Report" }),
  reports: tile("reports", { de: "Berichte", en: "Reports" }),
  schaltplan: tile("schaltplan", { de: "Verteilerpläne", en: "Panels" }, "construction"),
  werkstatt: tile("werkstatt", { de: "Werkstatt", en: "Workshop" }),
  messages: tile("messages", { de: "Nachrichten", en: "Messages" }, "both", "unread_messages"),
  time: tile("time", { de: "Zeit", en: "Time" }),
  wiki: tile("wiki", { de: "Wiki", en: "Wiki" }),
  projects_all: tile("projects_all", { de: "Projekte", en: "Projects" }),
  projects_map: tile("projects_map", { de: "Karte", en: "Map" }, "office"),
  customers: tile("customers", { de: "Kunden", en: "Customers" }),
  // Construction mode only, and only for apprentices and their trainers; the
  // sidebar (navViews) hides it from everyone else.
  ausbildung: tile("ausbildung", { de: "Ausbildung", en: "Training" }, "construction"),
});

/**
 * §5. FIELD is the old overview's tile row with the retired „Material“ swapped
 * for „Werkstatt“. The phone sets complement the bottom bar, which already
 * has Start, Aufgaben, Werkstatt, Zeit and Profil.
 */
export const SHORTCUT_PRESETS = Object.freeze({
  FIELD: Object.freeze(["my_tasks", "planning", "construction", "werkstatt", "messages", "time", "wiki"]),
  OFFICE: Object.freeze(["my_tasks", "planning", "projects_all", "customers", "calendar", "messages", "time", "wiki"]),
  M_FIELD: Object.freeze(["construction", "planning", "messages", "wiki"]),
  M_OFFICE: Object.freeze(["planning", "projects_all", "customers", "messages"]),
} satisfies Record<string, readonly DashboardShortcutView[]>);

/** The tiles of a widget without a choice: by workspace mode, and phone or not. */
export function shortcutPreset(mode: WorkspaceMode, device: DashboardDevice): readonly DashboardShortcutView[] {
  const office = mode === "office";
  if (device === "mobile") return office ? SHORTCUT_PRESETS.M_OFFICE : SHORTCUT_PRESETS.M_FIELD;
  return office ? SHORTCUT_PRESETS.OFFICE : SHORTCUT_PRESETS.FIELD;
}

/** The user's choice when there is one (1–12 views), else the preset. */
export function chosenShortcutViews(
  settings: DashboardWidgetSettings | null,
  mode: WorkspaceMode,
  device: DashboardDevice,
): readonly DashboardShortcutView[] {
  const views = settings?.views ?? [];
  return views.length > 0 ? views : shortcutPreset(mode, device);
}

/**
 * The tiles to render: the chosen ones the sidebar offers in this mode. When
 * not one of them is offered (a Büro-only choice seen in Baustelle mode), the
 * preset stands in, because an empty „Schnellzugriff“ is a dead card.
 */
export function visibleShortcutViews(
  settings: DashboardWidgetSettings | null,
  mode: WorkspaceMode,
  device: DashboardDevice,
  isOffered: (view: DashboardShortcutView) => boolean,
): DashboardShortcutView[] {
  const chosen = chosenShortcutViews(settings, mode, device).filter(isOffered);
  if (chosen.length > 0) return chosen;
  return shortcutPreset(mode, device).filter(isOffered);
}

/**
 * Ticks or unticks one view, keeping the order the user built (a new view
 * goes last). Refuses, by returning an unchanged copy, to drop the last view
 * or to add a thirteenth — the server would reject either (§3.1).
 */
export function toggleShortcutView(
  views: readonly DashboardShortcutView[],
  view: DashboardShortcutView,
): DashboardShortcutView[] {
  if (views.includes(view)) {
    return views.length <= 1 ? [...views] : views.filter((entry) => entry !== view);
  }
  return views.length >= DASHBOARD_MAX_SHORTCUT_VIEWS ? [...views] : [...views, view];
}

/** The old overview's rule: archived counts as finished, like done. */
function isFinished(status: string | null | undefined): boolean {
  const canonical = canonicalTaskStatus(status);
  return canonical === "done" || canonical === "archived";
}

function isAssignedTo(task: Task, userId: number): boolean {
  const ids = Array.isArray(task.assignee_ids) && task.assignee_ids.length > 0 ? task.assignee_ids : [];
  // Rows from before multi-assignment carry only `assignee_id`.
  return ids.length > 0 ? ids.includes(userId) : task.assignee_id === userId;
}

/** The „Meine Aufgaben“ badge: unfinished tasks assigned to the signed-in user. */
export function countOpenOwnTasks(tasks: readonly Task[], userId: number | null): number {
  if (userId === null) return 0;
  return tasks.filter((task) => isAssignedTo(task, userId) && !isFinished(task.status)).length;
}

/** The „Nachrichten“ badge: every unread message across the user's chats. */
export function sumUnreadMessages(threads: readonly Thread[]): number {
  return threads.reduce((sum, thread) => sum + Math.max(0, Number(thread.unread_count) || 0), 0);
}
