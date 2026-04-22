import type { PartnerListItem } from "../../types";
import { PartnerTradePill } from "./PartnerTradePill";

type Props = {
  partner: PartnerListItem;
  language: "de" | "en";
  onOpen: (id: number) => void;
  onEdit: (partner: PartnerListItem) => void;
  onArchiveToggle: (partner: PartnerListItem) => void;
};

function formatWhen(iso: string | null, language: "de" | "en"): string {
  if (!iso) return "—";
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return "—";
  const locale = language === "de" ? "de-DE" : "en-US";
  return dt.toLocaleDateString(locale, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/**
 * One row in the Werkstatt → Partner list table. Mirrors the lane-alignment
 * pattern used by `CustomerListRow` so the columns snap to the same widths.
 */
export function PartnerListRow({
  partner,
  language,
  onOpen,
  onEdit,
  onArchiveToggle,
}: Props) {
  const de = language === "de";
  const isArchived = Boolean(partner.archived_at);

  return (
    <tr className="partner-list-row">
      <td className="partner-list-cell partner-list-cell--name">
        <button
          type="button"
          className="partner-list-name-btn"
          onClick={() => onOpen(partner.id)}
        >
          <span className="partner-list-name">{partner.name}</span>
          {partner.contact_person && (
            <span className="partner-list-subname">{partner.contact_person}</span>
          )}
        </button>
      </td>
      <td className="partner-list-cell partner-list-cell--trade">
        {partner.trade ? (
          <PartnerTradePill trade={partner.trade} />
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td className="partner-list-cell partner-list-cell--contact">
        {partner.email && (
          <a className="partner-list-contact-link" href={`mailto:${partner.email}`}>
            {partner.email}
          </a>
        )}
        {partner.phone && (
          <a
            className="partner-list-contact-link"
            href={`tel:${partner.phone.replace(/\s+/g, "")}`}
          >
            {partner.phone}
          </a>
        )}
        {!partner.email && !partner.phone && <span className="muted">—</span>}
      </td>
      <td className="partner-list-cell partner-list-cell--tasks">
        <span className="partner-list-tasks-count">
          {partner.task_count} {de ? "gesamt" : "total"}
        </span>
        {partner.open_task_count > 0 && (
          <span className="partner-list-tasks-badge">
            {partner.open_task_count} {de ? "offen" : "open"}
          </span>
        )}
      </td>
      <td className="partner-list-cell partner-list-cell--activity">
        {formatWhen(partner.last_task_activity_at, language)}
      </td>
      <td className="partner-list-cell partner-list-cell--actions">
        <button
          type="button"
          className="partner-list-action-btn"
          onClick={() => onEdit(partner)}
          title={de ? "Bearbeiten" : "Edit"}
        >
          {de ? "Bearbeiten" : "Edit"}
        </button>
        <button
          type="button"
          className="partner-list-action-btn partner-list-action-btn--ghost"
          onClick={() => onArchiveToggle(partner)}
          title={
            isArchived
              ? de
                ? "Wiederherstellen"
                : "Unarchive"
              : de
                ? "Archivieren"
                : "Archive"
          }
        >
          {isArchived
            ? de
              ? "Wiederherstellen"
              : "Unarchive"
            : de
              ? "Archivieren"
              : "Archive"}
        </button>
      </td>
    </tr>
  );
}
