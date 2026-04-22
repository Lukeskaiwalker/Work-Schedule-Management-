/**
 * WerkstattMaintenanceRow — one entry in the "In Reparatur / Prüfung" card.
 * Mirrors Paper design node 7QR (Maintenance Card): lilac icon tile, stacked
 * title + meta, and a trailing category pill (repair / inspection / overdue).
 */
export type WerkstattMaintenanceBadge = "repair" | "inspection" | "overdue";

export interface WerkstattMaintenanceRowProps {
  toolName: string;
  context: string;
  badgeLabel: string;
  badge: WerkstattMaintenanceBadge;
}

export function WerkstattMaintenanceRow({
  toolName,
  context,
  badgeLabel,
  badge,
}: WerkstattMaintenanceRowProps) {
  return (
    <li className="werkstatt-maintenance-row">
      <span className="werkstatt-maintenance-icon" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path
            d="M14.5 4.5a4 4 0 0 1 5 5L14 15l-5 5-4-4 5-5 5.5-5.5ZM9.5 14.5l2 2"
            stroke="#6B2E9A"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <div className="werkstatt-maintenance-copy">
        <span className="werkstatt-maintenance-title">{toolName}</span>
        <span className="werkstatt-maintenance-meta">{context}</span>
      </div>
      <span
        className={`werkstatt-maintenance-badge werkstatt-maintenance-badge--${badge}`}
      >
        {badgeLabel}
      </span>
    </li>
  );
}
