/**
 * One Kundenbesuch in the feed (components/customers/CustomerVisitCard):
 * the meta line — "Besuch am <date> · <who went>", either half left out
 * when the row has none — a chip for the project it belongs to, and the
 * summary as typed. Bearbeiten swaps the summary for the form seeded with
 * the row; Löschen asks first. Both show only for whoever may change the
 * row — the card decides that, this component only renders it.
 */
import type { CustomerVisit } from "../../types";
import {
  CustomerVisitForm,
  draftFromVisit,
  type CustomerVisitDraft,
  type VisitProjectOption,
} from "./CustomerVisitForm";

type Props = {
  visit: CustomerVisit;
  projects: VisitProjectOption[];
  language: "de" | "en";
  canEdit: boolean;
  editing: boolean;
  saving: boolean;
  removing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (draft: CustomerVisitDraft) => void;
  onDelete: () => void;
};

/** ISO YYYY-MM-DD as the office writes dates; the raw string if it does not parse. */
function formatIsoDate(iso: string, language: "de" | "en"): string {
  const parsed = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString(language === "de" ? "de-DE" : "en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/**
 * The select's options for editing this row: the customer's projects,
 * plus the row's own when it is not among them (the list was filtered, or
 * the project is gone from it), so the edit can keep the link as it is.
 */
function optionsFor(visit: CustomerVisit, projects: VisitProjectOption[]): VisitProjectOption[] {
  if (visit.project_id === null) return projects;
  if (projects.some((project) => project.id === visit.project_id)) return projects;
  return [
    ...projects,
    { id: visit.project_id, project_number: visit.project_number ?? `#${visit.project_id}`, name: visit.project_name ?? "" },
  ];
}

export function CustomerVisitEntry({
  visit,
  projects,
  language,
  canEdit,
  editing,
  saving,
  removing,
  onEdit,
  onCancelEdit,
  onSave,
  onDelete,
}: Props) {
  const de = language === "de";
  const visitorName = visit.visit_by_name?.trim() || null;
  const metaParts = [
    visit.visit_date ? `${de ? "Besuch am" : "Visited on"} ${formatIsoDate(visit.visit_date, language)}` : null,
    visitorName,
  ].filter((part): part is string => part !== null);
  const linked = visit.project_id !== null;
  const chip = linked ? (visit.project_number ?? `#${visit.project_id}`) : de ? "Alle Projekte" : "All projects";

  return (
    <li className="customer-visit-item">
      <div className="customer-visit-item-head">
        {metaParts.length > 0 && <span className="customer-visit-meta">{metaParts.join(" · ")}</span>}
        <span
          className={`customer-visit-chip${linked ? "" : " customer-visit-chip--all"}`}
          title={linked ? (visit.project_name ?? undefined) : undefined}
        >
          {chip}
        </span>
      </div>

      {editing ? (
        <CustomerVisitForm
          initial={draftFromVisit(visit)}
          projects={optionsFor(visit, projects)}
          language={language}
          saving={saving}
          onSubmit={onSave}
          onCancel={onCancelEdit}
        />
      ) : (
        <>
          <div className="customer-visit-body">{visit.summary}</div>
          {canEdit && (
            <div className="customer-visit-item-actions">
              <button type="button" className="linklike" onClick={onEdit} disabled={removing}>
                {de ? "Bearbeiten" : "Edit"}
              </button>
              <button type="button" className="linklike" onClick={onDelete} disabled={removing}>
                {removing ? (de ? "Löscht…" : "Deleting…") : de ? "Löschen" : "Delete"}
              </button>
            </div>
          )}
        </>
      )}
    </li>
  );
}
