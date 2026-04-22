/**
 * WerkstattKpiChip — one of the four KPI tiles at the top of the Werkstatt
 * dashboard. Mirrors Paper design node 7JT/7JY/7K5/7KC: a white card with a
 * small uppercase label (optional colored status-dot) above a big number and
 * a quiet subtitle.
 *
 * Immutable props — no internal state.
 */
export type WerkstattKpiTone = "neutral" | "warning" | "info" | "danger";

export interface WerkstattKpiChipProps {
  label: string;
  value: string | number;
  subtitle: string;
  tone?: WerkstattKpiTone;
}

export function WerkstattKpiChip({
  label,
  value,
  subtitle,
  tone = "neutral",
}: WerkstattKpiChipProps) {
  const labelClass =
    tone === "neutral"
      ? "werkstatt-kpi-label"
      : `werkstatt-kpi-label werkstatt-kpi-label--${tone}`;
  return (
    <div className="werkstatt-kpi">
      <div className="werkstatt-kpi-label-row">
        {tone !== "neutral" && (
          <span
            className={`werkstatt-kpi-dot werkstatt-kpi-dot--${tone}`}
            aria-hidden="true"
          />
        )}
        <span className={labelClass}>{label}</span>
      </div>
      <div className="werkstatt-kpi-value-row">
        <span className="werkstatt-kpi-value">{value}</span>
        <span className="werkstatt-kpi-subtitle">{subtitle}</span>
      </div>
    </div>
  );
}
