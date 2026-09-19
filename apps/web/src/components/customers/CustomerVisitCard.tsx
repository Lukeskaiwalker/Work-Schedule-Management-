/**
 * "Kundenbesuch" on the customer page: what the first visit found.
 *
 * Whoever goes out to a new customer writes a few lines about it, and
 * those lines open every Projektbericht for that customer — so they are
 * kept on the customer, not on a project, and this card is where they are
 * read and edited. The edit is inline (a date and a textarea) and PATCHes
 * only the visit block; the page's customer row is replaced by the answer
 * through `onSaved`, so the contact card and the form open with the same
 * row this card just changed.
 */
import { useState } from "react";

import { useAppContext } from "../../context/AppContext";
import type { CustomerListItem } from "../../types";
import { saveCustomerVisit } from "../../utils/customersApi";
import "../../styles/customer-detail.css";

type Props = {
  customer: CustomerListItem;
  language: "de" | "en";
  onSaved: (customer: CustomerListItem) => void;
};

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

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

export function CustomerVisitCard({ customer, language, onSaved }: Props) {
  const { token, menuUserNameById, setError, setNotice } = useAppContext();
  const de = language === "de";

  const [editing, setEditing] = useState(false);
  const [summary, setSummary] = useState("");
  const [date, setDate] = useState("");
  const [saving, setSaving] = useState(false);

  const savedSummary = (customer.visit_summary ?? "").trim();
  const savedDate = (customer.visit_date ?? "").trim();
  const hasVisit = savedSummary.length > 0 || savedDate.length > 0;

  // The name of who went. The lookup answers "#id" for a user no longer in
  // the menu — nothing worth printing next to the date, so it is left out.
  const visitorName = (() => {
    const userId = customer.visit_by_user_id;
    if (userId == null || typeof menuUserNameById !== "function") return null;
    const name = menuUserNameById(userId);
    return name && !/^#\d+$/.test(name) ? name : null;
  })();

  const metaParts = [
    savedDate ? `${de ? "Besuch am" : "Visited on"} ${formatIsoDate(savedDate, language)}` : null,
    visitorName,
  ].filter((part): part is string => part !== null);

  function startEdit() {
    setSummary(customer.visit_summary ?? "");
    setDate(customer.visit_date ?? "");
    setEditing(true);
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      const updated = await saveCustomerVisit(token, customer.id, {
        // Empty is "no visit": the API takes null to clear, and "" is not a date.
        visit_summary: summary.trim() || null,
        visit_date: date.trim() || null,
      });
      onSaved(updated);
      setEditing(false);
      setNotice(de ? "Kundenbesuch gespeichert" : "Customer visit saved");
    } catch (err) {
      setError(messageOf(err, de ? "Kundenbesuch konnte nicht gespeichert werden" : "Failed to save customer visit"));
    } finally {
      setSaving(false);
    }
  }

  const hint = de ? "Wird am Anfang des Projektberichts gedruckt" : "Printed at the head of the project report";

  return (
    <section className="customer-visit-card">
      <header className="customer-contact-card-head">
        <h3 className="customer-contact-card-title">{de ? "Kundenbesuch" : "Customer visit"}</h3>
        {hasVisit && !editing && (
          <button type="button" className="linklike" onClick={startEdit}>
            {de ? "Bearbeiten" : "Edit"}
          </button>
        )}
      </header>

      {editing ? (
        <div className="customer-visit-form">
          <label className="customer-visit-field">
            {de ? "Besuch am" : "Visited on"}
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} disabled={saving} />
          </label>
          <label className="customer-visit-field">
            {de ? "Zusammenfassung des Besuchs" : "Summary of the visit"}
            <textarea
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              disabled={saving}
              aria-describedby="customer-visit-card-hint"
              placeholder={
                de
                  ? "Was der erste Termin ergeben hat: Lage, Wünsche, Besonderheiten"
                  : "What the first appointment found: situation, wishes, particulars"
              }
            />
          </label>
          <span className="customer-visit-hint" id="customer-visit-card-hint">
            {hint}
          </span>
          <div className="customer-visit-actions">
            <button type="button" className="customers-action-btn" onClick={() => setEditing(false)} disabled={saving}>
              {de ? "Abbrechen" : "Cancel"}
            </button>
            <button
              type="button"
              className="customers-action-btn customers-action-btn--primary"
              onClick={() => void save()}
              disabled={saving}
            >
              {saving ? (de ? "Speichert…" : "Saving…") : de ? "Speichern" : "Save"}
            </button>
          </div>
        </div>
      ) : hasVisit ? (
        <>
          {metaParts.length > 0 && <div className="customer-visit-meta">{metaParts.join(" · ")}</div>}
          {savedSummary ? (
            <div className="customer-visit-body">{savedSummary}</div>
          ) : (
            <small className="muted">{de ? "Ohne Zusammenfassung." : "No summary."}</small>
          )}
        </>
      ) : (
        <>
          <p className="muted customer-visit-empty">
            {de
              ? "Noch kein Besuch erfasst — was der erste Termin ergeben hat, gehört hierher. Wird am Anfang des Projektberichts gedruckt."
              : "No visit recorded yet — what the first appointment found belongs here. Printed at the head of the project report."}
          </p>
          <div className="customer-visit-actions">
            <button type="button" className="customers-action-btn" onClick={startEdit}>
              {de ? "Besuch erfassen" : "Record visit"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
