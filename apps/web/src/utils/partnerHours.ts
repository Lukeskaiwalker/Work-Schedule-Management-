// Partner hours as the office reads them (reported in the partner portal).
// The portal has its own copy of this formatting on purpose: the two apps
// keep separate vocabularies (see portal/portalTypes.ts).

import type { PartnerHoursEntry } from "../types";

export function formatPartnerHours(value: number): string {
  return `${String(Math.round(value * 100) / 100).replace(".", ",")} Std`;
}

/** "6 Std" for one person, "3 × 4 Std = 12 Std" for a crew. */
export function partnerHoursAmount(entry: Pick<PartnerHoursEntry, "workers" | "hours" | "total_hours">): string {
  if (entry.workers <= 1) return formatPartnerHours(entry.hours);
  return `${entry.workers} × ${formatPartnerHours(entry.hours)} = ${formatPartnerHours(entry.total_hours)}`;
}

/** "2026-10-08" → "08.10.2026", read as a calendar day (no Date, no timezone). */
export function partnerHoursDay(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split("-");
  return `${day}.${month}.${year}`;
}

export function partnerHoursTotal(entries: ReadonlyArray<Pick<PartnerHoursEntry, "total_hours">>): number {
  return Math.round(entries.reduce((sum, entry) => sum + entry.total_hours, 0) * 100) / 100;
}
