/** The server's bounds for a hand-added line (`PanelMaterialManualCreate`). */
export const MANUAL_QUANTITY_MAX = 9999;
export const MANUAL_LABEL_MAX = 255;
export const MANUAL_NOTE_MAX = 500;

/** "3" → 3; anything but a whole number from 1 to 9999 → null, so the form refuses what the server would. */
export function parseManualQuantity(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 1 && value <= MANUAL_QUANTITY_MAX ? value : null;
}
