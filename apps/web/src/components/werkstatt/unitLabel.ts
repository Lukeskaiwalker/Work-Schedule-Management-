/**
 * One unit abbreviation for the whole Werkstatt stock UI.
 *
 * The list row printed "9 Stk" while the dialog it opened printed "12 St." for
 * the same article — two abbreviations and two different numbers, which reads
 * as two different facts rather than as AVAILABLE beside TOTAL.
 *
 * Articles carry their own `unit` ("m", "Rolle", "Pack"), and that always wins:
 * a drum of cable is not measured in pieces. The fallback is only for articles
 * that have none, and it follows the interface language rather than being a
 * German abbreviation left standing in the English UI.
 */
export const FALLBACK_UNIT_DE = "Stk";
export const FALLBACK_UNIT_EN = "pcs";

export function unitLabel(unit: string | null | undefined, de: boolean): string {
  const own = (unit ?? "").trim();
  if (own) return own;
  return de ? FALLBACK_UNIT_DE : FALLBACK_UNIT_EN;
}
