import { useEffect, useMemo, useState } from "react";
import { useAppContext } from "../../context/AppContext";
import type { PartnerListItem } from "../../types";

type DraftState = {
  name: string;
  trade: string;
  contact_person: string;
  email: string;
  phone: string;
  address: string;
  tax_id: string;
  notes: string;
};

const EMPTY_DRAFT: DraftState = {
  name: "",
  trade: "",
  contact_person: "",
  email: "",
  phone: "",
  address: "",
  tax_id: "",
  notes: "",
};

function draftFromPartner(partner: PartnerListItem | null): DraftState {
  if (!partner) return EMPTY_DRAFT;
  return {
    name: partner.name ?? "",
    trade: partner.trade ?? "",
    contact_person: partner.contact_person ?? "",
    email: partner.email ?? "",
    phone: partner.phone ?? "",
    address: partner.address ?? "",
    tax_id: partner.tax_id ?? "",
    notes: partner.notes ?? "",
  };
}

function isEmailish(value: string): boolean {
  if (!value) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * Create / edit Partner modal. Opened via `openPartnerModal({ initial,
 * onSaved })` on AppContext. On save, calls `savePartner`, fires
 * `onSaved(partner)` if provided (this is how `PartnerMultiSelect` auto-adds
 * the newly-created partner to the task), then closes.
 */
export function PartnerModal() {
  const {
    language,
    partnerModalOpen,
    partnerModalDraft,
    closePartnerModal,
    savePartner,
    partners,
    setError,
  } = useAppContext();

  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);

  // Reset local form when the modal opens with a new seed.
  useEffect(() => {
    if (!partnerModalOpen) return;
    setDraft({
      ...draftFromPartner(partnerModalDraft?.initial ?? null),
      name:
        partnerModalDraft?.prefillName ??
        partnerModalDraft?.initial?.name ??
        "",
    });
  }, [
    partnerModalOpen,
    partnerModalDraft?.initial?.id,
    partnerModalDraft?.prefillName,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  // Unique trade values across existing partners — used to populate the
  // <datalist> so users don't accidentally create "Elektrik" vs "Elektro".
  const tradeSuggestions = useMemo<string[]>(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    partners.forEach((row) => {
      const value = (row.trade ?? "").trim();
      if (!value) return;
      const key = value.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(value);
    });
    return out.sort((a, b) => a.localeCompare(b));
  }, [partners]);

  if (!partnerModalOpen) return null;

  const de = language === "de";
  const editingId = partnerModalDraft?.initial?.id ?? null;
  const isEdit = editingId !== null;

  function updateField<K extends keyof DraftState>(key: K, value: DraftState[K]): void {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving) return;
    const name = draft.name.trim();
    if (!name) {
      setError(de ? "Firmenname ist erforderlich" : "Company name is required");
      return;
    }
    if (draft.email && !isEmailish(draft.email)) {
      setError(de ? "Ungültige E-Mail-Adresse" : "Invalid email address");
      return;
    }
    setSaving(true);
    try {
      const saved = await savePartner(
        {
          name,
          trade: draft.trade.trim() || null,
          contact_person: draft.contact_person.trim() || null,
          email: draft.email.trim() || null,
          phone: draft.phone.trim() || null,
          address: draft.address.trim() || null,
          tax_id: draft.tax_id.trim() || null,
          notes: draft.notes.trim() || null,
        },
        editingId ?? undefined,
      );
      partnerModalDraft?.onSaved?.(saved);
      closePartnerModal();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message || (de ? "Partner konnte nicht gespeichert werden" : "Failed to save partner"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={closePartnerModal}>
      <div
        className="card modal-card task-modal-card partner-modal-card"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <form className="task-modal-form" onSubmit={onSubmit}>
          <header className="task-modal-head">
            <div className="task-modal-eyebrow">
              <span className="task-modal-eyebrow-label">
                {isEdit
                  ? de
                    ? "PARTNER BEARBEITEN"
                    : "EDIT PARTNER"
                  : de
                    ? "NEUER PARTNER"
                    : "NEW PARTNER"}
              </span>
            </div>
            <h2 className="task-modal-title">
              {draft.name.trim() ||
                (isEdit
                  ? de
                    ? "Partner bearbeiten"
                    : "Edit partner"
                  : de
                    ? "Neuer Partner"
                    : "New partner")}
            </h2>
          </header>

          <section className="task-modal-section task-modal-section--grid2">
            <label className="task-modal-field">
              <span className="task-modal-field-label">
                {de ? "Firma *" : "Company *"}
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
                {de ? "Gewerk" : "Trade"}
              </span>
              <input
                className="task-modal-input"
                value={draft.trade}
                onChange={(event) => updateField("trade", event.target.value)}
                list="partner-trade-suggestions"
                placeholder={de ? "z. B. Elektro, Sanitär…" : "e.g. Elektro, Sanitär…"}
              />
              <datalist id="partner-trade-suggestions">
                {tradeSuggestions.map((trade) => (
                  <option key={`partner-trade-option-${trade}`} value={trade} />
                ))}
              </datalist>
            </label>
          </section>

          <section className="task-modal-section task-modal-section--grid2">
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
          </section>

          <section className="task-modal-section task-modal-section--grid2">
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
            <label className="task-modal-field">
              <span className="task-modal-field-label">
                {de ? "USt-ID" : "Tax ID"}
              </span>
              <input
                className="task-modal-input"
                value={draft.tax_id}
                onChange={(event) => updateField("tax_id", event.target.value)}
                placeholder="DE123456789"
              />
            </label>
          </section>

          <section className="task-modal-section task-modal-section--stack">
            <label className="task-modal-field">
              <span className="task-modal-field-label">
                {de ? "Adresse" : "Address"}
              </span>
              <textarea
                className="task-modal-input task-modal-textarea"
                value={draft.address}
                onChange={(event) => updateField("address", event.target.value)}
                rows={2}
                placeholder={
                  de
                    ? "Straße und Nr., PLZ Ort"
                    : "Street and number, ZIP City"
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
                rows={3}
                placeholder={
                  de
                    ? "Zahlungsziel, Kooperationshinweise…"
                    : "Payment terms, collaboration notes…"
                }
              />
            </label>
          </section>

          <footer className="task-modal-footer">
            <div className="project-modal-footer-spacer" />
            <button
              type="button"
              className="task-modal-btn task-modal-btn--ghost"
              onClick={closePartnerModal}
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
                    ? "Partner anlegen"
                    : "Create partner"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
