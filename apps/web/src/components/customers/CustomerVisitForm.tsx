/**
 * The Kundenbesuch form: when it was, which project it belongs to, what it
 * found. The composer at the top of the feed and the inline edit of an
 * entry are the same form seeded differently (components/customers/
 * CustomerVisitCard, CustomerVisitEntry).
 *
 * The form holds strings only — what its inputs show — and hands the
 * draft back on Speichern; `visitWriteFromDraft` turns it into what the
 * API takes, kept apart so the mapping can be tested without a render.
 * The hint under the textarea follows the project choice: an unlinked
 * visit prints at the head of every Projektbericht of the customer, a
 * linked one only at the head of that project's.
 */
import { useId, useState } from "react";

import type { CustomerVisit } from "../../types";
import type { CustomerVisitCreate } from "../../utils/customersApi";

/** One of the customer's projects, as the select lists it. */
export type VisitProjectOption = {
  id: number;
  project_number: string;
  name: string;
};

/** What the inputs hold: "" where nothing is chosen. `project_id` is the option value. */
export type CustomerVisitDraft = {
  summary: string;
  visit_date: string;
  project_id: string;
};

/** What Speichern sends: the draft trimmed and typed. */
export type CustomerVisitWrite = Required<Pick<CustomerVisitCreate, "summary" | "visit_date" | "project_id">>;

// Mirrors the server's limit on a summary, so the browser stops the typing
// where the API would refuse it.
export const VISIT_MAX_CHARS = 8000;

export const EMPTY_VISIT_DRAFT: CustomerVisitDraft = {
  summary: "",
  visit_date: "",
  project_id: "",
};

export function draftFromVisit(visit: CustomerVisit): CustomerVisitDraft {
  return {
    summary: visit.summary,
    visit_date: visit.visit_date ?? "",
    project_id: visit.project_id === null ? "" : String(visit.project_id),
  };
}

/**
 * Trimmed and typed. An empty summary comes back as "" — the caller
 * refuses it, the API would too — and an empty date or project as null:
 * "" is not a date, and null is "all of the customer's projects".
 */
export function visitWriteFromDraft(draft: CustomerVisitDraft): CustomerVisitWrite {
  return {
    summary: draft.summary.trim(),
    visit_date: draft.visit_date.trim() || null,
    project_id: draft.project_id ? Number(draft.project_id) : null,
  };
}

type Props = {
  initial: CustomerVisitDraft;
  projects: VisitProjectOption[];
  language: "de" | "en";
  saving: boolean;
  onSubmit: (draft: CustomerVisitDraft) => void;
  onCancel: () => void;
};

export function CustomerVisitForm({ initial, projects, language, saving, onSubmit, onCancel }: Props) {
  const de = language === "de";
  const hintId = useId();
  const [draft, setDraft] = useState<CustomerVisitDraft>(initial);

  function update<K extends keyof CustomerVisitDraft>(key: K, value: CustomerVisitDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  const linked = projects.find((project) => String(project.id) === draft.project_id) ?? null;
  const hint = linked
    ? de
      ? `Wird am Anfang des Projektberichts von ${linked.project_number} gedruckt`
      : `Printed at the head of the project report of ${linked.project_number}`
    : de
      ? "Wird am Anfang jedes Projektberichts dieses Kunden gedruckt"
      : "Printed at the head of every project report of this customer";

  return (
    <div className="customer-visit-form">
      <label className="customer-visit-field">
        {de ? "Besuch am" : "Visited on"}
        <input
          type="date"
          value={draft.visit_date}
          onChange={(event) => update("visit_date", event.target.value)}
          disabled={saving}
        />
      </label>
      <label className="customer-visit-field">
        {de ? "Projekt" : "Project"}
        <select
          value={draft.project_id}
          onChange={(event) => update("project_id", event.target.value)}
          disabled={saving}
        >
          <option value="">{de ? "Alle Projekte dieses Kunden" : "All projects of this customer"}</option>
          {projects.map((project) => (
            <option key={project.id} value={String(project.id)}>
              {`${project.project_number} · ${project.name}`}
            </option>
          ))}
        </select>
      </label>
      <label className="customer-visit-field">
        {de ? "Zusammenfassung des Besuchs" : "Summary of the visit"}
        <textarea
          value={draft.summary}
          onChange={(event) => update("summary", event.target.value)}
          maxLength={VISIT_MAX_CHARS}
          disabled={saving}
          aria-describedby={hintId}
          placeholder={
            de
              ? "Was der erste Termin ergeben hat: Lage, Wünsche, Besonderheiten"
              : "What the first appointment found: situation, wishes, particulars"
          }
        />
      </label>
      <span className="customer-visit-hint" id={hintId}>
        {hint}
      </span>
      <div className="customer-visit-actions">
        <button type="button" className="customers-action-btn" onClick={onCancel} disabled={saving}>
          {de ? "Abbrechen" : "Cancel"}
        </button>
        <button
          type="button"
          className="customers-action-btn customers-action-btn--primary"
          onClick={() => onSubmit(draft)}
          disabled={saving}
        >
          {saving ? (de ? "Speichert…" : "Saving…") : de ? "Speichern" : "Save"}
        </button>
      </div>
    </div>
  );
}
