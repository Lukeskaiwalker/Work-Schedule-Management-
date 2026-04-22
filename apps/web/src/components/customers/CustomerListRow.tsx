import type { CustomerListItem } from "../../types";

type Props = {
  customer: CustomerListItem;
  language: "de" | "en";
  onOpen: (id: number) => void;
  onEdit: (customer: CustomerListItem) => void;
  onArchiveToggle: (customer: CustomerListItem) => void;
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
 * One row in the `CustomersPage` table. Uses fixed-width slots for icon
 * columns (projects badge, kebab) so rows align across vertical lanes even
 * when the middle columns wrap.
 */
export function CustomerListRow({
  customer,
  language,
  onOpen,
  onEdit,
  onArchiveToggle,
}: Props) {
  const de = language === "de";
  const isArchived = Boolean(customer.archived_at);

  return (
    <tr className="customer-list-row">
      <td className="customer-list-cell customer-list-cell--name">
        <button
          type="button"
          className="customer-list-name-btn"
          onClick={() => onOpen(customer.id)}
        >
          <span className="customer-list-name">{customer.name}</span>
          {customer.contact_person && (
            <span className="customer-list-subname">{customer.contact_person}</span>
          )}
        </button>
      </td>
      <td className="customer-list-cell customer-list-cell--address">
        {customer.address ? (
          customer.address
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td className="customer-list-cell customer-list-cell--contact">
        {customer.email && (
          <a className="customer-list-contact-link" href={`mailto:${customer.email}`}>
            {customer.email}
          </a>
        )}
        {customer.phone && (
          <a
            className="customer-list-contact-link"
            href={`tel:${customer.phone.replace(/\s+/g, "")}`}
          >
            {customer.phone}
          </a>
        )}
        {!customer.email && !customer.phone && <span className="muted">—</span>}
      </td>
      <td className="customer-list-cell customer-list-cell--projects">
        <span className="customer-list-projects-count">
          {customer.project_count} {de ? "gesamt" : "total"}
        </span>
        {customer.active_project_count > 0 && (
          <span className="customer-list-projects-badge">
            {customer.active_project_count} {de ? "aktiv" : "active"}
          </span>
        )}
      </td>
      <td className="customer-list-cell customer-list-cell--activity">
        {formatWhen(customer.last_project_activity_at, language)}
      </td>
      <td className="customer-list-cell customer-list-cell--actions">
        <button
          type="button"
          className="customer-list-action-btn"
          onClick={() => onEdit(customer)}
          title={de ? "Bearbeiten" : "Edit"}
        >
          {de ? "Bearbeiten" : "Edit"}
        </button>
        <button
          type="button"
          className="customer-list-action-btn customer-list-action-btn--ghost"
          onClick={() => onArchiveToggle(customer)}
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
