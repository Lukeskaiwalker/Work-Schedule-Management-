// Display helpers shared by the two Werkstatt overview screens.
//
// They live here rather than in the pages because both screens render the same
// three things — a ledger movement, a return deadline, a price — and the pages
// disagreeing about what "überfällig" means would be a bug nobody reports:
// the dashboard card and the full list would simply show different numbers.

import { parseServerDateTime } from "./dates";
import type { WerkstattMovementType } from "../types/werkstatt";

export type WerkstattDueStatus = "no_date" | "on_site" | "due_soon" | "due_today" | "overdue";

/** Days from now until `target`, by calendar day rather than by 24h blocks —
 *  "heute zurück" must stay true at 23:00, not flip to "morgen". */
function calendarDayDelta(target: Date, now: Date): number {
  const a = Date.UTC(target.getFullYear(), target.getMonth(), target.getDate());
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((a - b) / 86_400_000);
}

/**
 * Overdue is decided by the INSTANT, the rest by the calendar day.
 *
 * The instant rule is not a preference: the server stamps `is_overdue` with
 * exactly `expected_return_at < now`, and that flag is what the group counts
 * and the KPI strip add up. A client rule that waited for midnight would let a
 * row sit green under a headline counting it as late — two answers to the same
 * question on one screen, which is worse than either answer alone.
 *
 * Below that line the calendar day is the right unit, so a deadline at 08:00
 * tomorrow reads "Morgen zurück" rather than "in 18 Stunden".
 */
export function dueStatus(expectedReturnAt: string | null, now: Date): WerkstattDueStatus {
  const due = parseServerDateTime(expectedReturnAt);
  if (!due) return "no_date";
  if (due.getTime() < now.getTime()) return "overdue";
  const days = calendarDayDelta(due, now);
  if (days === 0) return "due_today";
  if (days <= 7) return "due_soon";
  return "on_site";
}

function shortDate(value: Date, de: boolean): string {
  return value.toLocaleDateString(de ? "de-DE" : "en-US", {
    day: "2-digit",
    month: "2-digit",
  });
}

/** What the deadline column says. Never invents one: an item checked out with
 *  no return date says so instead of borrowing today's. */
export function formatDueLabel(expectedReturnAt: string | null, now: Date, de: boolean): string {
  const due = parseServerDateTime(expectedReturnAt);
  if (!due) return de ? "Ohne Rückgabedatum" : "No return date";
  const days = calendarDayDelta(due, now);
  // Late on the same calendar day still counts as late — see `dueStatus`.
  if (days < 0 || (days === 0 && due.getTime() < now.getTime())) {
    const late = Math.abs(days);
    if (late === 0) return de ? "Heute fällig gewesen" : "Was due today";
    if (de) return late === 1 ? "1 Tag überfällig" : `${late} Tage überfällig`;
    return late === 1 ? "1 day overdue" : `${late} days overdue`;
  }
  if (days === 0) return de ? "Heute zurück" : "Due today";
  if (days === 1) return de ? "Morgen zurück" : "Due tomorrow";
  return de ? `Bis ${shortDate(due, de)}` : `Due ${shortDate(due, de)}`;
}

/** Coarse age of a ledger row, for the right-hand column of the movements
 *  card. Minutes, then hours, then a date — the same ladder a chat app uses. */
export function formatRelativeTime(value: string | null, now: Date, de: boolean): string {
  const at = parseServerDateTime(value);
  if (!at) return "—";
  const minutes = Math.round((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return de ? "gerade eben" : "just now";
  if (minutes < 60) return de ? `vor ${minutes} Min.` : `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return de ? `vor ${hours} Std.` : `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return de ? `vor ${days} T.` : `${days} d ago`;
  return shortDate(at, de);
}

/**
 * Ledger movement type → the four pips `WerkstattMovementRow` draws.
 *
 * `repair_out` gets its own pip because a tool going to the repair shop is the
 * one movement a workshop chases; the rest collapse into "went out", "came
 * back" and "somebody corrected a number".
 */
export function movementPipKind(
  movementType: WerkstattMovementType | string,
): "out" | "in" | "adjust" | "repair" {
  if (movementType === "checkout") return "out";
  if (movementType === "return" || movementType === "intake" || movementType === "repair_back") {
    return "in";
  }
  if (movementType === "repair_out") return "repair";
  return "adjust";
}

const MOVEMENT_LABELS: Record<string, { de: string; en: string }> = {
  checkout: { de: "Entnommen", en: "Checked out" },
  return: { de: "Zurückgegeben", en: "Returned" },
  intake: { de: "Eingelagert", en: "Stocked in" },
  correction: { de: "Abgeschrieben", en: "Written off" },
  repair_out: { de: "In Reparatur", en: "To repair" },
  repair_back: { de: "Aus Reparatur", en: "Back from repair" },
  inventory_plus: { de: "Inventur +", en: "Stock-take +" },
  inventory_minus: { de: "Inventur −", en: "Stock-take −" },
};

export function movementTypeLabel(movementType: string, de: boolean): string {
  const entry = MOVEMENT_LABELS[movementType];
  if (!entry) return movementType;
  return de ? entry.de : entry.en;
}

/** `null` stays `null` — a missing price must not render as "0,00 €". */
export function formatCents(cents: number | null | undefined, de: boolean): string | null {
  if (cents == null) return null;
  return (cents / 100).toLocaleString(de ? "de-DE" : "en-US", {
    style: "currency",
    currency: "EUR",
  });
}

/** "3 Stk" / "3 m" — the unit as the article carries it, or bare pieces. */
export function formatQuantity(quantity: number, unit: string | null | undefined): string {
  const trimmed = (unit ?? "").trim();
  return trimmed ? `${quantity} ${trimmed}` : String(quantity);
}

/**
 * "1 Projekt" / "2 Projekte".
 *
 * German has no free plural-s, so a count spliced into a fixed plural noun
 * reads as a bug in the page — and a reader who spots one careless number
 * starts doubting the careful ones next to it.
 */
export function pluralize(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
