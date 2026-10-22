/**
 * Unsaved start-page drafts, in memory, per user and device class
 * (docs/DASHBOARD.md §8.2).
 *
 * Navigation runs through the sidebar, the drawer and the bottom bar, none of
 * which the start page controls, so leaving it mid-edit cannot be stopped or
 * confirmed. The host keeps its draft here instead and reopens edit mode with
 * it when the user comes back on the same device class.
 *
 * `takeDraft` reads without removing: React.StrictMode renders twice
 * (main.tsx), and a consuming read in a state initializer would hand the draft
 * to the first render and nothing to the one that is kept. The host removes it
 * with `clearDraft` on „Fertig“ (success), „Abbrechen“ and reset.
 *
 * Memory only, never localStorage, and dropped when the session ends: a
 * shared workshop tablet must not reopen one person's draft for the next.
 */
import type { DashboardDevice, DashboardWidgetItem } from "../types/dashboard";
import { onDashboardSessionEnd } from "./dashboardSession";

const drafts = new Map<string, readonly DashboardWidgetItem[]>();

function keyOf(userId: number, device: DashboardDevice): string {
  return `${userId}:${device}`;
}

/** A deep copy: neither the caller's later edits nor the reader's may reach the stored draft. */
function copyOf(widgets: readonly DashboardWidgetItem[]): DashboardWidgetItem[] {
  return widgets.map((item) =>
    item.settings ? { id: item.id, size: item.size, settings: { views: [...item.settings.views] } } : { id: item.id, size: item.size },
  );
}

export function rememberDraft(userId: number, device: DashboardDevice, widgets: readonly DashboardWidgetItem[]): void {
  drafts.set(keyOf(userId, device), Object.freeze(copyOf(widgets)));
}

export function takeDraft(userId: number, device: DashboardDevice): DashboardWidgetItem[] | null {
  const stored = drafts.get(keyOf(userId, device));
  return stored ? copyOf(stored) : null;
}

export function clearDraft(userId: number, device: DashboardDevice): void {
  drafts.delete(keyOf(userId, device));
}

onDashboardSessionEnd(() => drafts.clear());
