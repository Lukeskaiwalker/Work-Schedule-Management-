import { useEffect, useState } from "react";
import { useAppContext } from "../../context/AppContext";
import type { CustomerListItem } from "../../types";

type DraftState = {
  name: string;
  address: string;
  contact_person: string;
  email: string;
  phone: string;
  tax_id: string;
  notes: string;
  // ISO YYYY-MM-DD or "" when unset; matches the value shape of `<input
  // type="date">` so we can two-way-bind without a parser/formatter.
  birthday: string;
  marktakteur_nummer: string;
};

const EMPTY_DRAFT: DraftState = {
  name: "",
  address: "",
  contact_person: "",
  email: "",
  phone: "",
  tax_id: "",
  notes: "",
  birthday: "",
  marktakteur_nummer: "",
};

function draftFromCustomer(customer: CustomerListItem | null): DraftState {
  if (!customer) return EMPTY_DRAFT;
  return {
    name: customer.name ?? "",
    address: customer.address ?? "",
    contact_person: customer.contact_person ?? "",
    email: customer.email ?? "",
    phone: customer.phone ?? "",
    tax_id: customer.tax_id ?? "",
    notes: customer.notes ?? "",
    birthday: customer.birthday ?? "",
    marktakteur_nummer: customer.marktakteur_nummer ?? "",
  };
}

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

  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
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

  function updateField<K extends keyof DraftState>(key: K, value: DraftState[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const name = draft.name.trim();
    if (!name) {
      setError(de ? "Kundenname ist erforderlich" : "Customer name is required");
      return;
    }
    if (draft.email && !isEmailish(draft.email)) {
      setError(de ? "Ungültige E-Mail-Adresse" : "Invalid email address");
      return;
    }
    setSaving(true);
    try {
      const saved = await saveCustomer(
        {
          name,
          address: draft.address.trim() || null,
          contact_person: draft.contact_person.trim() || null,
          email: draft.email.trim() || null,
          phone: draft.phone.trim() || null,
          tax_id: draft.tax_id.trim() || null,
          notes: draft.notes.trim() || null,
          // Empty string from <input type="date"> means "no birthday set",
          // so we send null rather than "" — Pydantic rejects "" for date.
          birthday: draft.birthday.trim() || null,
          marktakteur_nummer: draft.marktakteur_nummer.trim() || null,
        },
        editingId ?? undefined,
      );
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

          <section className="task-modal-section task-modal-section--grid2">
            <label className="task-modal-field">
              <span className="task-modal-field-label">
                {de ? "Kundenname *" : "Customer name *"}
              </span>
              <input
                className="task-modal-input"
                value={draft.name}
                onChange={(event) => updateField("name", event.target.value)}
                required
                autoFocus
              />
            </label>
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
                {de ? "Telefon" : "Phone"}
              </span>
              <input
                className="task-modal-input"
                value={draft.phone}
                onChange={(event) => updateField("phone", event.target.value)}
              />
            </label>
          </section>

          <section className="task-modal-section task-modal-section--grid2">
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
          </section>

          <section className="task-modal-section task-modal-section--grid2">
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

          <section className="task-modal-section task-modal-section--stack">
            <label className="task-modal-field">
              <span className="task-modal-field-label">
                {de ? "Interne Notizen" : "Internal notes"}
              </span>
              <textarea
                className="task-modal-input task-modal-textarea"
                value={draft.notes}
                onChange={(event) => updateField("notes", event.target.value)}
                rows={4}
                placeholder={
                  de
                    ? "Zahlungsziel, Besonderheiten, interne Hinweise"
                    : "Payment terms, quirks, internal notes"
                }
              />
            </label>
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
