/**
 * The arithmetic and wording behind a board's Arbeitszeit block, kept apart
 * from the component so it can be pinned in a test without rendering.
 *
 * Hours are DECIMAL ("2,50 h") because this block is read the way a
 * Nachkalkulation is: hours times a rate. The wall screen says "2:30 h"
 * instead, because a person glancing at it reads a clock, not an invoice.
 */
import type { PanelLabourLine } from "../../types/schaltplan";
import { parseServerDateTime } from "../../utils/dates";

/** A session running longer than this is far more likely forgotten than worked. */
export const STALE_RUNNING_HOURS = 12;

export function formatLabourHours(minutes: number, language: "de" | "en"): string {
  const hours = Math.max(0, Number.isFinite(minutes) ? minutes : 0) / 60;
  const text = new Intl.NumberFormat(language === "de" ? "de-DE" : "en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(hours);
  return `${text} h`;
}

/** "14:02" today, "04.10. 14:02" on another day — when a running session began. */
export function formatRunningSince(iso: string | null, now: Date, language: "de" | "en"): string {
  const start = parseServerDateTime(iso);
  if (!start) return "";
  const locale = language === "de" ? "de-DE" : "en-GB";
  const time = start.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const sameDay =
    start.getFullYear() === now.getFullYear() &&
    start.getMonth() === now.getMonth() &&
    start.getDate() === now.getDate();
  if (sameDay) return time;
  const day = start.toLocaleDateString(locale, { day: "2-digit", month: "2-digit" });
  return `${day} ${time}`;
}

export function isStale(iso: string | null, now: Date): boolean {
  const start = parseServerDateTime(iso);
  if (!start) return false;
  return now.getTime() - start.getTime() > STALE_RUNNING_HOURS * 3600 * 1000;
}

/**
 * Whether this viewer may end the line's running session: their own, or
 * anybody's with werkstatt:manage. The server decides again; this only keeps
 * a button off the screen that would answer 403.
 */
export function canEndRunning(
  line: PanelLabourLine,
  currentUserId: number | null | undefined,
  canManageWerkstatt: boolean,
): boolean {
  if (line.running_session_id == null) return false;
  return canManageWerkstatt || (currentUserId != null && line.user_id === currentUserId);
}

/** `YYYY-MM-DDTHH:mm` in local time — the value a datetime-local input wants. */
export function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}
