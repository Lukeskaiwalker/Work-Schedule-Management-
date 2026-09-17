/**
 * Label helpers for the two phone screens.
 *
 * Pure functions with `now` injected, for the same reason the checkout
 * dialog's Friday chip is computed rather than hard-coded: the fixtures these
 * screens used to render carried strings like "seit 3 Tagen" that were wrong
 * on every day but one. A phone screen that states how long a tool has been
 * out has to derive it from the timestamp the server sent.
 */

import type { WerkstattMovementType } from "../../../types/werkstatt";

/** Calendar days from `then` to `now`, in local time. Negative when future. */
function calendarDaysBetween(then: Date, now: Date): number {
  const a = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/**
 * "seit heute" / "seit gestern" / "seit 4 Tagen" for a checkout timestamp.
 *
 * Returns null for a timestamp that will not parse, so the caller can drop the
 * segment instead of printing "seit NaN Tagen".
 */
export function sinceLabel(iso: string, now: Date, de: boolean): string | null {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  const days = Math.max(0, calendarDaysBetween(parsed, now));
  if (days === 0) return de ? "seit heute" : "since today";
  if (days === 1) return de ? "seit gestern" : "since yesterday";
  return de ? `seit ${days} Tagen` : `${days} days out`;
}

/**
 * Whether the agreed return date has passed.
 *
 * No date agreed is not overdue: the checkout dialog's "Datum…" chip sends
 * null on purpose rather than inventing a deadline, and a row must not be
 * coloured red for a promise nobody made.
 */
export function isOverdue(latestExpectedReturnAt: string | null, now: Date): boolean {
  if (!latestExpectedReturnAt) return false;
  const due = new Date(latestExpectedReturnAt);
  if (Number.isNaN(due.getTime())) return false;
  return due.getTime() < now.getTime();
}

/** Project caption for a checkout row — the number when there is one. */
export function projectLabel(
  row: { project_number: string | null; project_name: string | null },
  de: boolean,
): string {
  return row.project_number ?? row.project_name ?? (de ? "ohne Projekt" : "no project");
}

/**
 * The visual family a ledger movement belongs to.
 *
 * Three families exist as CSS variants (`--checkout`, `--return`,
 * `--inspection`); the ledger has eight movement types. Anything that is
 * neither a hand-out nor a hand-back is a stock correction and shares the
 * neutral third look.
 */
export function movementFamily(
  type: WerkstattMovementType,
): "checkout" | "return" | "inspection" {
  if (type === "checkout") return "checkout";
  if (type === "return" || type === "repair_back") return "return";
  return "inspection";
}

const MOVEMENT_TITLES: Record<WerkstattMovementType, { de: string; en: string }> = {
  checkout: { de: "Entnommen", en: "Checked out" },
  return: { de: "Zurückgegeben", en: "Returned" },
  intake: { de: "Wareneingang", en: "Goods in" },
  correction: { de: "Korrektur", en: "Correction" },
  repair_out: { de: "Zur Reparatur", en: "Sent for repair" },
  repair_back: { de: "Aus Reparatur zurück", en: "Back from repair" },
  inventory_plus: { de: "Inventur +", en: "Stock-take +" },
  inventory_minus: { de: "Inventur −", en: "Stock-take −" },
};

/** What a ledger movement is called on screen. */
export function movementTitle(type: WerkstattMovementType, de: boolean): string {
  const entry = MOVEMENT_TITLES[type];
  // A movement type the API grows before this map does is still shown — as
  // its raw key. Better an unfamiliar word than a blank row in a ledger.
  if (!entry) return type;
  return de ? entry.de : entry.en;
}

/** "12. Sep, 14:30" — compact enough for a phone row. */
export function shortDateTime(iso: string, de: boolean): string | null {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleString(de ? "de-DE" : "en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** `3× · 12. Sep, 14:30 · Anna M.` — the second line of a movement row. */
export function movementSubtitle(
  movement: {
    quantity: number;
    created_at: string;
    user_display_name: string;
    project_number: string | null;
  },
  de: boolean,
): string {
  const parts = [
    `${movement.quantity}×`,
    shortDateTime(movement.created_at, de),
    movement.user_display_name,
    movement.project_number,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" · ");
}

/**
 * Greeting for the start screen.
 *
 * The screen said "Guten Morgen" at every hour of the day, including at ten in
 * the evening. It is one line of arithmetic to be right instead.
 */
export function greeting(now: Date, firstName: string, de: boolean): string {
  const hour = now.getHours();
  const head =
    hour < 11
      ? de
        ? "Guten Morgen"
        : "Good morning"
      : hour < 18
        ? de
          ? "Guten Tag"
          : "Good afternoon"
        : de
          ? "Guten Abend"
          : "Good evening";
  return firstName ? `${head}, ${firstName}` : head;
}

/**
 * What to tell the user after a return was booked.
 *
 * Names the condition, because the three of them do different things to the
 * counters, and quotes the totals the SERVER answered with rather than any
 * figure the phone was holding.
 */
export function returnNotice(
  input: {
    condition: "ok" | "repair" | "lost";
    quantity: number;
    itemName: string;
    availableAfter: number;
    totalAfter: number;
  },
  de: boolean,
): string {
  const head =
    input.condition === "ok"
      ? de
        ? "zurückgegeben"
        : "returned"
      : input.condition === "repair"
        ? de
          ? "zur Reparatur gebucht"
          : "sent for repair"
        : de
          ? "als verloren ausgebucht"
          : "written off as lost";
  const totals = de
    ? `${input.availableAfter} von ${input.totalAfter} verfügbar`
    : `${input.availableAfter} of ${input.totalAfter} available`;
  return `${input.quantity}× ${input.itemName} ${head} — ${totals}`;
}
