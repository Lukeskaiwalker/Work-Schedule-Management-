import { useEffect, useState } from "react";
import { useAppContext } from "../../context/AppContext";
import {
  EMPTY_CUSTOMER_DRAFT,
  draftFromCustomer,
  writeInputFromDraft,
  type CustomerDraft,
} from "./customerModalDraft";
import "../../styles/customer-modal.css";

function isEmailish(value: string): boolean {
  if (!value) return true;
  // Deliberately lenient — the backend validates properly. UI just rejects
  // obviously broken input (no @, no dot after @).
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * Create / edit customer modal. Opened via `openCustomerModal({ initial,
 * onSaved })` on AppContext. On save, calls `saveCustomer`, fires
 * `onSaved(customer)` if provided (this is how ProjectModal auto-selects
 * the freshly-created customer after inline create), then closes.
 *
 * A customer is a Firma or a Privatperson, and the form follows the choice:
 * a company has a Firmenname and an Ansprechpartner, a person just a Name.
 * The choice is required for a new customer; a row from before the field
 * may stay unset, and says so, until someone decides. The notes textarea
 * is gone — the customer's notes are a feed on the page now, like the
 * project's — and the Kundenbesuch block closes the form: what the first
 * visit found, printed at the head of every Projektbericht.
 */
export function CustomerModal() {
  const {
    language,
    customerModalOpen,
    customerModalDraft,
    closeCustomerModal,
    saveCustomer,
    setError,
  } = useAppContext();

  const [draft, setDraft] = useState<CustomerDraft>(EMPTY_CUSTOMER_DRAFT);
  const [saving, setSaving] = useState(false);

  // Reset the local form whenever the modal opens with a different seed.
  // We key off `customerModalOpen` + `initial?.id` so reopening the modal
  // (e.g. after an inline create) starts from a clean slate.
  useEffect(() => {
    if (!customerModalOpen) return;
    setDraft({
      ...draftFromCustomer(customerModalDraft?.initial ?? null),
      // Prefill name when the combobox passed a fresh query ("+ Neuen Kunden
      // anlegen: »Meier«" → name: "Meier").
      name:
        customerModalDraft?.prefillName ??
        customerModalDraft?.initial?.name ??
        "",
    });
  }, [
    customerModalOpen,
    customerModalDraft?.initial?.id,
    customerModalDraft?.prefillName,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!customerModalOpen) return null;

  const de = language === "de";
  const editingId = customerModalDraft?.initial?.id ?? null;
  const isEdit = editingId !== null;
  const isCompany = draft.customer_type === "company";
  const isPrivate = draft.customer_type === "private";
  const nameLabel = isCompany
    ? de ? "Firmenname *" : "Company name *"
    : isPrivate
      ? "Name *"
      : de ? "Kundenname *" : "Customer name *";

  function updateField<K extends keyof CustomerDraft>(key: K, value: CustomerDraft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    // A new customer says what it is; an old row may keep its silence.
    if (!isEdit && !draft.customer_type) {
      setError(de ? "Bitte Firma oder Privatperson wählen" : "Please choose company or private person");
      return;
    }
    const input = writeInputFromDraft(draft);
    if (!input.name) {
      setError(de ? "Kundenname ist erforderlich" : "Customer name is required");
      return;
    }
    if (draft.email && !isEmailish(draft.email)) {
      setError(de ? "Ungültige E-Mail-Adresse" : "Invalid email address");
      return;
    }
    setSaving(true);
    try {
      const saved = await saveCustomer(input, editingId ?? undefined);
      // Notify the opener (e.g. ProjectModal) with the saved row. Defer
      // closing to give `onSaved` a chance to update its local state first.
      customerModalDraft?.onSaved?.(saved);
      closeCustomerModal();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message || (de ? "Kunde konnte nicht gespeichert werden" : "Failed to save customer"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={closeCustomerModal}>
      <div
        className="card modal-card task-modal-card customer-modal-card"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <form className="task-modal-form" onSubmit={onSubmit}>
          <header className="task-modal-head">
            <div className="task-modal-eyebrow">
              <span className="task-modal-eyebrow-label">
                {isEdit
                  ? de
                    ? "KUNDE BEARBEITEN"
                    : "EDIT CUSTOMER"
                  : de
                    ? "NEUER KUNDE"
                    : "NEW CUSTOMER"}
              </span>
            </div>
            <h2 className="task-modal-title">
              {draft.name.trim() ||
                (isEdit
                  ? de
                    ? "Kunde bearbeiten"
                    : "Edit customer"
                  : de
                    ? "Neuer Kunde"
                    : "New customer")}
            </h2>
          </header>

          <section className="task-modal-section task-modal-section--stack">
            <div className="task-modal-field">
              <span className="task-modal-field-label" id="customer-type-label">
                {de ? "Kundenart *" : "Customer type *"}
              </span>
              <div className="customer-type-switch">
                <div className="customer-type-switch-pill" role="radiogroup" aria-labelledby="customer-type-label">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={isCompany}
                    className={`customer-type-switch-btn${isCompany ? " customer-type-switch-btn--active" : ""}`}
                    onClick={() => updateField("customer_type", "company")}
                  >
                    {de ? "Firma" : "Company"}
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={isPrivate}
                    className={`customer-type-switch-btn${isPrivate ? " customer-type-switch-btn--active" : ""}`}
                    onClick={() => updateField("customer_type", "private")}
                  >
                    {de ? "Privatperson" : "Private person"}
                  </button>
                </div>
                {isEdit && !draft.customer_type && (
                  <span className="muted customer-type-unset">
                    {de ? "(nicht festgelegt)" : "(not set)"}
                  </span>
                )}
              </div>
            </div>
          </section>

          <section className="task-modal-section task-modal-section--grid2">
            <label className="task-modal-field">
              <span className="task-modal-field-label">{nameLabel}</span>
              <input
                className="task-modal-input"
                value={draft.name}
                onChange={(event) => updateField("name", event.target.value)}
                required
                autoFocus
              />
            </label>
            {!isPrivate && (
              <label className="task-modal-field">
                <span className="task-modal-field-label">
                  {de ? "Ansprechpartner" : "Contact person"}
                </span>
                <input
                  className="task-modal-input"
                  value={draft.contact_person}
                  onChange={(event) => updateField("contact_person", event.target.value)}
                />
              </label>
            )}
          </section>

          <section className="task-modal-section task-modal-section--grid2">
            <label className="task-modal-field">
              <span className="task-modal-field-label">
                {de ? "Telefon" : "Phone"}
              </span>
              <input
                className="task-modal-input"
                type="tel"
                value={draft.phone}
                onChange={(event) => updateField("phone", event.target.value)}
              />
            </label>
            <label className="task-modal-field">
              <span className="task-modal-field-label">
                {de ? "Mobil" : "Mobile"}
              </span>
              <input
                className="task-modal-input"
                type="tel"
                value={draft.mobile}
                onChange={(event) => updateField("mobile", event.target.value)}
              />
            </label>
          </section>

          <section className="task-modal-section task-modal-section--grid2">
            <label className="task-modal-field">
              <span className="task-modal-field-label">
                {de ? "E-Mail" : "Email"}
              </span>
              <input
                className="task-modal-input"
                type="email"
                value={draft.email}
                onChange={(event) => updateField("email", event.target.value)}
              />
            </label>
            <label className="task-modal-field">
              <span className="task-modal-field-label">
                {de ? "Adresse" : "Address"}
              </span>
              <textarea
                className="task-modal-input task-modal-textarea"
                value={draft.address}
                onChange={(event) => updateField("address", event.target.value)}
                rows={3}
                placeholder={
                  de
                    ? "Straße und Nr., PLZ Ort, Land"
                    : "Street and number, ZIP City, Country"
                }
              />
            </label>
          </section>

          <section className="task-modal-section task-modal-section--grid2">
            <label className="task-modal-field">
              <span className="task-modal-field-label">
                {de ? "Steuer-ID" : "Tax ID"}
              </span>
              <input
                className="task-modal-input"
                value={draft.tax_id}
                onChange={(event) => updateField("tax_id", event.target.value)}
                placeholder="DE123456789"
              />
            </label>
            <label className="task-modal-field">
              <span className="task-modal-field-label">
                {de ? "Geburtstag" : "Birthday"}
              </span>
              <input
                className="task-modal-input"
                type="date"
                value={draft.birthday}
                onChange={(event) => updateField("birthday", event.target.value)}
              />
            </label>
          </section>

          <section className="task-modal-section task-modal-section--grid2">
            <label className="task-modal-field">
              <span className="task-modal-field-label">
                {de ? "Marktakteur-Nr." : "Market actor no."}
              </span>
              <input
                className="task-modal-input"
                value={draft.marktakteur_nummer}
                onChange={(event) =>
                  updateField("marktakteur_nummer", event.target.value)
                }
                placeholder="SEE901234567890"
                title={
                  de
                    ? "Marktstammdatenregister-Nummer (für PV-Anlagen, Speicher, etc.)"
                    : "Marktstammdatenregister number (for PV plants, batteries, etc.)"
                }
              />
            </label>
          </section>

          <section className="task-modal-section task-modal-section--stack customer-visit-section">
            <h3 className="customer-modal-subhead">{de ? "Kundenbesuch" : "Customer visit"}</h3>
            <label className="task-modal-field">
              <span className="task-modal-field-label">
                {de ? "Besuch am" : "Visited on"}
              </span>
              <input
                className="task-modal-input"
                type="date"
                value={draft.visit_date}
                onChange={(event) => updateField("visit_date", event.target.value)}
              />
            </label>
            {/* The hint sits outside the label: inside it, it would become
                part of the field's name. */}
            <label className="task-modal-field">
              <span className="task-modal-field-label">
                {de ? "Zusammenfassung des Besuchs" : "Summary of the visit"}
              </span>
              <textarea
                className="task-modal-input task-modal-textarea"
                value={draft.visit_summary}
                onChange={(event) => updateField("visit_summary", event.target.value)}
                rows={4}
                aria-describedby="customer-visit-summary-hint"
                placeholder={
                  de
                    ? "Was der erste Termin ergeben hat: Lage, Wünsche, Besonderheiten"
                    : "What the first appointment found: situation, wishes, particulars"
                }
              />
            </label>
            <span className="task-modal-field-hint" id="customer-visit-summary-hint">
              {de
                ? "Wird am Anfang des Projektberichts gedruckt"
                : "Printed at the head of the project report"}
            </span>
          </section>

          <footer className="task-modal-footer">
            <div className="project-modal-footer-spacer" />
            <button
              type="button"
              className="task-modal-btn task-modal-btn--ghost"
              onClick={closeCustomerModal}
              disabled={saving}
            >
              {de ? "Abbrechen" : "Cancel"}
            </button>
            <button
              type="submit"
              className="task-modal-btn task-modal-btn--primary"
              disabled={saving}
            >
              {saving
                ? de
                  ? "Speichert…"
                  : "Saving…"
                : isEdit
                  ? de
                    ? "Änderungen speichern"
                    : "Save changes"
                  : de
                    ? "Kunde anlegen"
                    : "Create customer"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
