/**
 * WerkstattMovementRow — a single line in the "Letzte Bewegungen" card.
 * Mirrors Paper design node 7MX (Activity Card). Each row has a colored
 * circular direction pip, a stacked title/subtitle, and a right-aligned
 * relative timestamp column of fixed width for vertical-lane alignment.
 */
export type WerkstattMovementKind = "out" | "in" | "adjust" | "repair";

export interface WerkstattMovementRowProps {
  kind: WerkstattMovementKind;
  title: string;
  subtitle: string;
  timestamp: string;
}

function MovementPipIcon({ kind }: { kind: WerkstattMovementKind }) {
  if (kind === "out") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M5 12h14M13 6l6 6-6 6"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (kind === "in") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M19 12H5M11 18l-6-6 6-6"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (kind === "adjust") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M12 5v14M5 12h14"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  // repair
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M14.5 4.5a4 4 0 0 1 5 5L14 15l-5 5-4-4 5-5 5.5-5.5ZM9.5 14.5l2 2"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function WerkstattMovementRow({
  kind,
  title,
  subtitle,
  timestamp,
}: WerkstattMovementRowProps) {
  return (
    <li className="werkstatt-movement-row">
      <span
        className={`werkstatt-movement-pip werkstatt-movement-pip--${kind}`}
        aria-hidden="true"
      >
        <MovementPipIcon kind={kind} />
      </span>
      <div className="werkstatt-movement-copy">
        <span className="werkstatt-movement-title">{title}</span>
        <span className="werkstatt-movement-subtitle">{subtitle}</span>
      </div>
      <span className="werkstatt-movement-time">{timestamp}</span>
    </li>
  );
}
