/**
 * Pure operations on a start-page layout (docs/DASHBOARD.md §11.2).
 *
 * Every function returns a new array and never changes its input. That is
 * load-bearing, not style: the host decides whether „Fertig“ sends a PUT by
 * comparing the draft with the loaded layout (`sameLayout`), and a mutated
 * loaded layout would compare equal to the draft — the save would silently be
 * skipped. Unchanged items are shared, never edited in place.
 */
import type {
  DashboardDevice,
  DashboardWidgetId,
  DashboardWidgetItem,
  DashboardWidgetSettings,
  DashboardWidgetSize,
} from "../types/dashboard";

/** Rows a list widget shows per size (§1.1); more rows become „+n weitere“. */
export const DASHBOARD_ROW_LIMIT: Readonly<Record<DashboardWidgetSize, number>> = Object.freeze({
  small: 3,
  medium: 5,
  large: 10,
});

/**
 * Grid columns per device (D10). From the device, never from the viewport:
 * the admin previews a phone layout on a desktop, and edit mode keeps the
 * device it started on while the window changes.
 */
export const DASHBOARD_COLUMNS: Readonly<Record<DashboardDevice, 1 | 2 | 3>> = Object.freeze({
  mobile: 1,
  tablet: 2,
  desktop: 3,
});

/** S = one column, M = two, L = the full row; each clamped to the device's columns. */
export function columnSpan(size: DashboardWidgetSize, device: DashboardDevice): 1 | 2 | 3 {
  const columns = DASHBOARD_COLUMNS[device];
  const wanted = size === "small" ? 1 : size === "medium" ? 2 : columns;
  return Math.min(wanted, columns) as 1 | 2 | 3;
}

/**
 * The device for a width, from `(min-width: 768px)` and `(min-width: 1280px)`
 * (D9). Two queries and nothing in between, so a fractional width can never
 * fall into a gap; the desktop query wins if the two ever disagree.
 */
export function deviceFromMatches(atLeastTablet: boolean, atLeastDesktop: boolean): DashboardDevice {
  if (atLeastDesktop) return "desktop";
  return atLeastTablet ? "tablet" : "mobile";
}

/** Moves the item at `from` to `to` (clamped). An index outside the list changes nothing. */
export function moveWidget(widgets: readonly DashboardWidgetItem[], from: number, to: number): DashboardWidgetItem[] {
  const next = [...widgets];
  if (!Number.isInteger(from) || from < 0 || from >= next.length) return next;
  const target = Math.max(0, Math.min(Math.trunc(to), next.length - 1));
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return next;
}

/** One step towards the front (-1) or the back (+1); stays put at the ends. */
export function moveWidgetBy(
  widgets: readonly DashboardWidgetItem[],
  id: DashboardWidgetId,
  delta: -1 | 1,
): DashboardWidgetItem[] {
  const index = widgets.findIndex((item) => item.id === id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= widgets.length) return [...widgets];
  return moveWidget(widgets, index, target);
}

/** Appends `id` at `size`. A widget appears at most once per layout (D11), so a placed id is a no-op. */
export function addWidget(
  widgets: readonly DashboardWidgetItem[],
  id: DashboardWidgetId,
  size: DashboardWidgetSize,
): DashboardWidgetItem[] {
  if (widgets.some((item) => item.id === id)) return [...widgets];
  return [...widgets, { id, size }];
}

export function removeWidget(widgets: readonly DashboardWidgetItem[], id: DashboardWidgetId): DashboardWidgetItem[] {
  return widgets.filter((item) => item.id !== id);
}

export function resizeWidget(
  widgets: readonly DashboardWidgetItem[],
  id: DashboardWidgetId,
  size: DashboardWidgetSize,
): DashboardWidgetItem[] {
  return widgets.map((item) => (item.id === id ? { ...item, size } : item));
}

/**
 * Replaces one item's settings with a copy. `null` drops the key: the client
 * never sends `settings: null` (§2.1), and the shortcut preset applies then.
 */
export function setWidgetSettings(
  widgets: readonly DashboardWidgetItem[],
  id: DashboardWidgetId,
  settings: DashboardWidgetSettings | null,
): DashboardWidgetItem[] {
  return widgets.map((item) => {
    if (item.id !== id) return item;
    const { id: itemId, size } = item;
    return settings ? { id: itemId, size, settings: { views: [...settings.views] } } : { id: itemId, size };
  });
}

/** Only the items whose id is in `keep`, in their order. */
export function pruneWidgets(
  widgets: readonly DashboardWidgetItem[],
  keep: ReadonlySet<DashboardWidgetId>,
): DashboardWidgetItem[] {
  return widgets.filter((item) => keep.has(item.id));
}

function sameViews(a: DashboardWidgetItem["settings"] | null, b: DashboardWidgetItem["settings"] | null): boolean {
  // Missing and null are the same "no choice" (§2.1). Tile order is part of
  // the choice, so the views compare in order.
  const left = a?.views ?? null;
  const right = b?.views ?? null;
  if (left === null || right === null) return left === right;
  return left.length === right.length && left.every((view, index) => view === right[index]);
}

/** Same widgets, same order, same sizes, same tiles. */
export function sameLayout(a: readonly DashboardWidgetItem[], b: readonly DashboardWidgetItem[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => {
    const other = b[index];
    return item.id === other.id && item.size === other.size && sameViews(item.settings, other.settings);
  });
}
