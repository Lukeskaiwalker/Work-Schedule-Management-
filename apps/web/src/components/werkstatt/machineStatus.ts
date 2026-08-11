/**
 * Shared presentation helpers for Maschinen.
 *
 * Lives in one module rather than being repeated across the list, the detail
 * panel and the modals: a machine that reads "Ausgegeben" in the table and
 * "Unterwegs" in the dialog is the same machine, and nobody would trust either
 * label. One definition, imported everywhere.
 */
import type { Language } from "../../types";
import type { MachineStatus } from "../../types/werkstattMachines";
import { parseServerDateTime } from "../../utils/dates";

type Bilingual = { de: string; en: string };

export const MACHINE_STATUS_LABELS: Record<MachineStatus, Bilingual> = {
  verfuegbar: { de: "Verfügbar", en: "Available" },
  ausgegeben: { de: "Ausgegeben", en: "Checked out" },
  wartung: { de: "In Wartung", en: "In service" },
  defekt: { de: "Defekt", en: "Broken" },
  ausgemustert: { de: "Ausgemustert", en: "Retired" },
};

/**
 * Status → the tone suffix on `.werkstatt-machine-pill--*`.
 *
 * `wartung` and `defekt` share the danger tone on purpose: from the shop
 * floor's point of view both mean "do not take this", and giving them separate
 * colours would imply a distinction that does not change what you do next.
 */
export const MACHINE_STATUS_TONES: Record<MachineStatus, string> = {
  verfuegbar: "available",
  ausgegeben: "out",
  wartung: "service",
  defekt: "broken",
  ausgemustert: "retired",
};

export function machineStatusLabel(status: MachineStatus, language: Language): string {
  const entry = MACHINE_STATUS_LABELS[status];
  if (!entry) return status;
  return language === "de" ? entry.de : entry.en;
}

/**
 * Short, table-friendly date: "12.08." / "Aug 12", and the year only when it is
 * not the current one. A column of "12.08.2026" repeated forty times is four
 * characters of noise per row that nobody reads.
 */
export function formatMachineDate(
  value: string | null | undefined,
  language: Language,
): string {
  const parsed = parseServerDateTime(value);
  if (!parsed) return "—";
  const de = language === "de";
  const sameYear = parsed.getFullYear() === new Date().getFullYear();
  return parsed.toLocaleDateString(de ? "de-DE" : "en-US", {
    day: "2-digit",
    month: de ? "2-digit" : "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Date + time, used where the exact hand-over moment matters (the log). */
export function formatMachineDateTime(
  value: string | null | undefined,
  language: Language,
): string {
  const parsed = parseServerDateTime(value);
  if (!parsed) return "—";
  const de = language === "de";
  return parsed.toLocaleString(de ? "de-DE" : "en-US", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Whole days from today until `value`; negative when it is already past.
 *
 * Compares calendar days rather than 24-hour spans, because "due tomorrow" has
 * to mean tomorrow's date and not "in 24 hours" — an inspection due tomorrow
 * 08:00, checked today at 18:00, is 14 hours away and would otherwise round to
 * "today".
 */
export function daysUntil(value: string | null | undefined): number | null {
  const parsed = parseServerDateTime(value);
  if (!parsed) return null;
  const startOfDay = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const MS_PER_DAY = 86_400_000;
  return Math.round((startOfDay(parsed) - startOfDay(new Date())) / MS_PER_DAY);
}

/**
 * "heute" / "morgen" / "in 5 Tagen" / "3 Tage überfällig".
 *
 * Returns null when there is no date, so callers can decide what "never
 * inspected" should read as in their own context.
 */
export function relativeDayLabel(
  value: string | null | undefined,
  language: Language,
): string | null {
  const days = daysUntil(value);
  if (days === null) return null;
  const de = language === "de";
  if (days === 0) return de ? "heute" : "today";
  if (days === 1) return de ? "morgen" : "tomorrow";
  if (days === -1) return de ? "1 Tag überfällig" : "1 day overdue";
  if (days < 0) {
    const late = Math.abs(days);
    return de ? `${late} Tage überfällig` : `${late} days overdue`;
  }
  return de ? `in ${days} Tagen` : `in ${days} days`;
}

/**
 * Where the machine physically is, as one line.
 *
 * Person wins over location when both are set: a drill booked to Max, in the
 * Bulli, is found by asking Max. The van is where it sleeps, not who has it.
 */
export function machineWhereabouts(
  machine: { holder_name: string | null; current_location_name: string | null },
  language: Language,
): string {
  if (machine.holder_name) return machine.holder_name;
  if (machine.current_location_name) return machine.current_location_name;
  return language === "de" ? "Kein Lagerort" : "No location";
}
