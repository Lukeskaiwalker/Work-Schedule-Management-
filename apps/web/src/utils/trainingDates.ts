// Local-date helpers for the Wochenbericht week math.
//
// Deliberately NOT Date.toISOString(): that converts to UTC first, so shortly
// after midnight local time it returns *yesterday* — which turned "current
// week" into last week for anyone opening the editor in the evening. The same
// trap is documented in TimePage's calendar code; these helpers format the
// LOCAL date and never cross a day boundary.

function toLocalISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Monday (ISO date) of the week containing `iso`. */
export function mondayOf(iso: string): string {
  const d = new Date(`${iso}T12:00:00`); // midday dodges DST edges
  const shift = (d.getDay() + 6) % 7; // JS Sunday=0 → Monday-based offset
  d.setDate(d.getDate() - shift);
  return toLocalISO(d);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return toLocalISO(d);
}

/** Monday of the CURRENT local week. */
export function currentWeekMonday(): string {
  return mondayOf(toLocalISO(new Date()));
}
