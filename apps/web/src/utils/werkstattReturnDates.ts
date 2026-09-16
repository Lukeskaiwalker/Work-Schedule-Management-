/**
 * Expected-return chips for the Werkstatt checkout dialog.
 *
 * The dialog offers four chips; `POST /werkstatt/mobile/checkout` wants an
 * `expected_return_at` datetime. This turns one into the other.
 *
 * Kept pure (with `now` injected) because the Friday chip used to be the
 * literal string "Freitag, 19. Apr" from the design mock — a date that was
 * wrong every week of the year except one, and that nothing ever sent.
 */
export type ReturnOption = "tonight" | "tomorrow" | "friday" | "custom";

/** Workshop close of day. Nobody brings a tool back at midnight. */
const RETURN_HOUR = 18;

const FRIDAY = 5;

function atClosingTime(base: Date, addDays: number): Date {
  const result = new Date(base.getFullYear(), base.getMonth(), base.getDate() + addDays);
  result.setHours(RETURN_HOUR, 0, 0, 0);
  return result;
}

/** Days from `now` to the coming Friday; 0 when today already is Friday. */
function daysUntilFriday(now: Date): number {
  return (FRIDAY - now.getDay() + 7) % 7;
}

/**
 * The concrete date a chip means, or `null` when it names none.
 *
 * "custom" resolves to null: there is no date picker in this dialog yet, so
 * the honest reading is "a date will be agreed", not a silently invented one.
 */
export function resolveExpectedReturn(option: ReturnOption | null, now: Date): Date | null {
  if (option === "tonight") return atClosingTime(now, 0);
  if (option === "tomorrow") return atClosingTime(now, 1);
  if (option === "friday") return atClosingTime(now, daysUntilFriday(now));
  return null;
}

/** ISO 8601 for the API, or null. */
export function expectedReturnIso(option: ReturnOption | null, now: Date): string | null {
  return resolveExpectedReturn(option, now)?.toISOString() ?? null;
}

/** Chip caption. The Friday chip names the actual coming Friday. */
export function returnOptionLabel(option: ReturnOption, de: boolean, now: Date): string {
  if (option === "tonight") return de ? "Heute Abend" : "Tonight";
  if (option === "tomorrow") return de ? "Morgen" : "Tomorrow";
  if (option === "friday") {
    const friday = atClosingTime(now, daysUntilFriday(now));
    const formatted = friday.toLocaleDateString(de ? "de-DE" : "en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
    return formatted;
  }
  return de ? "Datum…" : "Date…";
}
