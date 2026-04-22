/** Format duration in minutes to a human label: "2h 30m", "3h", or "45m". */
export function formatDurationLabel(minutes: number | null): string {
  if (minutes == null || minutes <= 0) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}
