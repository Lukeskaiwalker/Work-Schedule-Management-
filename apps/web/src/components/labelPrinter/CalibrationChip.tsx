/**
 * Per-material calibration chip (docs/LABEL_PRINTER_CALIBRATION.md §7.10).
 *
 * Says what was done and when — "Eingemessen", "Kalibriert", "Gespeichert mit
 * Abweichung" — never that the printer behaviour was checked. A record whose
 * profile changed since (fingerprint differs) reads "Profil seit Messung
 * geändert", because its numbers describe a profile that no longer exists.
 */
import type { CalibrationSummary } from "../../types/labelPrinter";
import { calibrationChip } from "../../utils/labelCalibration";
import "../../styles/label-calibration.css";

export interface CalibrationChipProps {
  calibration: CalibrationSummary | null;
  de?: boolean;
}

export function CalibrationChip({ calibration, de = true }: CalibrationChipProps) {
  const chip = calibrationChip(calibration, de);
  const title = calibration
    ? [calibration.by_name, calibration.notes].filter(Boolean).join(" · ") || undefined
    : undefined;
  return (
    <span className={`lc-chip lc-chip--${chip.tone}`} title={title}>
      {chip.text}
    </span>
  );
}
