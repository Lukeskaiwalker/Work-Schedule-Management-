import type { PartnerHoursEntry } from "../../types";
import { partnerHoursAmount, partnerHoursDay } from "../../utils/partnerHours";
import "../../styles/partner-portal-office.css";

/**
 * Hours partners reported in the portal, as the office reads them: one row
 * per day and crew, with the job it was for and who sent it. Removing is a
 * correction of what gets paid, so it is offered only to `projects:manage`
 * (the caller decides through `onDelete`) and asks first.
 */
export function PartnerHoursList({
  entries,
  showPartner,
  showTask,
  busyId,
  onDelete,
}: {
  entries: PartnerHoursEntry[];
  showPartner: boolean;
  showTask: boolean;
  busyId?: number | null;
  onDelete?: (entry: PartnerHoursEntry) => void;
}) {
  return (
    <ul className="partner-hours-list">
      {entries.map((entry) => (
        <li key={entry.id} className="partner-hours-row">
          <span className="partner-hours-day">{partnerHoursDay(entry.work_date)}</span>
          <span className="partner-hours-body">
            <span className="partner-hours-amount">
              {partnerHoursAmount(entry)}
              {showPartner && <span className="partner-hours-partner"> · {entry.partner.name}</span>}
            </span>
            {showTask && <span className="partner-hours-meta">{entry.task ? entry.task.title : "Ohne bestimmte Aufgabe"}</span>}
            {entry.note && <span className="partner-hours-note">{entry.note}</span>}
            {entry.reported_by && <span className="partner-hours-meta">gemeldet von {entry.reported_by}</span>}
            {onDelete && (
              <button
                type="button"
                className="linklike partner-hours-remove"
                disabled={busyId === entry.id}
                onClick={() => onDelete(entry)}
                aria-label={`Stunden vom ${partnerHoursDay(entry.work_date)} entfernen`}
              >
                Entfernen
              </button>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
