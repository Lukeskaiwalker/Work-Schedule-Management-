/**
 * The label printer's dots — twin of `apps/api/app/services/werkstatt_label_profile.py`.
 *
 * The WAGO 258-5101 has a 300 dpi head and feeds 300 dots per inch: 300 / 25,4
 * ≈ 11,81 dots per mm (`PHYSICAL_DOTS_PER_MM`). A ruler laid out at 12 per mm
 * printed 1,9 % long (physical test T4, 13.10.2026). The printer's OWN
 * millimetre is dots / 12 — it only matters for the `^Q`/`^W` the API sends,
 * never for a length shown or drawn here.
 */

/** Head dots per real millimetre: 300 dpi. */
export const DOTS_PER_MM = 300 / 25.4;

/**
 * Millimetres → head dots, rounded half up once — twin of `mm_to_dots`. Add
 * the millimetres up first and convert the sum, as the printer path does, so a
 * long rail does not collect every segment's rounding.
 */
export function mmToDots(mm: number): number {
  return Math.round(mm * DOTS_PER_MM);
}
