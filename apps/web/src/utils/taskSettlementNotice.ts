/**
 * The half-sentence a completion notice ends with: where the rest went.
 *
 * Its own module rather than a closure in App.tsx because it is the one part
 * of the completion flow with a rule worth pinning — it must read the SERVER's
 * answer, never the choice that was clicked. The two can disagree: a crate
 * whose last line is removed in another tab (or at the Pi) between the preview
 * and the PATCH is emptied whatever the dialog said, and a notice phrased from
 * the dialog would then promise "Rest bleibt in K3" while the Kisten page
 * shows an empty crate.
 */
import type { MaterialSettlementResult } from "../types/taskSettlement";

/**
 * @param settlement what the server says it did — absent when nothing was settled.
 * @param hadRemainder whether the preview saw anything left over. Keeps the
 *   shelf line quiet for the overwhelming majority of completions, where
 *   there was never a rest to place anywhere.
 * @param de German UI (English fallback otherwise).
 */
export function remainderOutcomeText(
  settlement: MaterialSettlementResult | null | undefined,
  { hadRemainder, de }: { hadRemainder: boolean; de: boolean },
): string | null {
  if (!settlement) return null;
  const boxNumber = settlement.remainder_box_number ?? "";
  // A crate number is worth saying even when nobody was asked: it tells the
  // office where to look for the material.
  if (boxNumber && settlement.disposition === "same_box") {
    return de ? `Rest bleibt in ${boxNumber}` : `Rest stays in ${boxNumber}`;
  }
  if (boxNumber && settlement.disposition === "new_box") {
    return de ? `Neue Kiste ${boxNumber} angelegt` : `New box ${boxNumber} created`;
  }
  if (!hadRemainder) return null;
  return de ? "Rest eingelagert" : "Rest put back in stock";
}
