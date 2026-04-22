/**
 * Color palette for the Team Calendar view.
 * Each user gets a distinct color based on their position in the selected-users list.
 * 12 visually distinct pairs: pastel background + saturated border/text.
 */
export const TEAM_CALENDAR_COLORS = [
  { bg: "#DBEAFE", border: "#2563EB", text: "#1E40AF" },  // Blue
  { bg: "#FEE2E2", border: "#DC2626", text: "#991B1B" },  // Red
  { bg: "#D1FAE5", border: "#059669", text: "#065F46" },  // Green
  { bg: "#FFEDD5", border: "#EA580C", text: "#9A3412" },  // Orange
  { bg: "#EDE9FE", border: "#7C3AED", text: "#5B21B6" },  // Purple
  { bg: "#CFFAFE", border: "#0891B2", text: "#155E75" },  // Teal
  { bg: "#FEF9C3", border: "#CA8A04", text: "#854D0E" },  // Yellow
  { bg: "#FCE7F3", border: "#DB2777", text: "#9D174D" },  // Pink
  { bg: "#F1F5F9", border: "#475569", text: "#1E293B" },  // Slate
  { bg: "#E0E7FF", border: "#4338CA", text: "#3730A3" },  // Indigo
  { bg: "#ECFCCB", border: "#65A30D", text: "#3F6212" },  // Lime
  { bg: "#FEF3C7", border: "#D97706", text: "#92400E" },  // Amber
] as const;

export type TeamColor = (typeof TEAM_CALENDAR_COLORS)[number];

export function getUserColor(index: number): TeamColor {
  return TEAM_CALENDAR_COLORS[index % TEAM_CALENDAR_COLORS.length];
}
