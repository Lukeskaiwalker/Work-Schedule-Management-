import { useEffect, useState } from "react";

/**
 * CategoryFormModal — create / edit a Werkstatt category. Reused for both
 * flows; distinguished by the `mode` prop. Top-level categories and
 * sub-categories share the same shape; the parent picker decides which.
 *
 * Pure presentational — the host page owns state + persistence. The modal
 * emits `onSave` with the form snapshot; host performs the mutation.
 */

export type CategoryFormMode = "create" | "edit";

export interface CategoryFormPayload {
  id: string | null;          // null on create
  name: string;
  parent_id: string | null;   // null = top-level
  notes: string;
}

export interface CategoryFormModalProps {
  open: boolean;
  mode: CategoryFormMode;
  initial: CategoryFormPayload;
  /** Top-level categories the user can pick as parent. Empty = only top-level allowed. */
  topLevelOptions: ReadonlyArray<{ id: string; name: string }>;
  language: "de" | "en";
  onClose: () => void;
  onSave: (payload: CategoryFormPayload) => void;
  onArchive?: () => void;     // shown in edit mode when provided
}

export function CategoryFormModal({
  open,
  mode,
  initial,
  topLevelOptions,
  language,
  onClose,
  onSave,
  onArchive,
}: CategoryFormModalProps) {
  const [name, setName] = useState(initial.name);
  const [parentId, setParentId] = useState<string | null>(initial.parent_id);
  const [notes, setNotes] = useState(initial.notes);

  // Re-seed form when the initial payload changes (user picked a different row).
  useEffect(() => {
    setName(initial.name);
    setParentId(initial.parent_id);
    setNotes(initial.notes);
  }, [initial.id, initial.name, initial.parent_id, initial.notes]);

  if (!open) return null;

  const de = language === "de";
  const trimmedName = name.trim();
  const canSave = trimmedName.length > 0;

  function handleSave() {
    if (!canSave) return;
    onSave({
      id: initial.id,
      name: trimmedName,
      parent_id: parentId,
      notes: notes.trim(),
    });
  }

  return (
    <div className="werkstatt-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="werkstatt-modal werkstatt-modal--narrow"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cat-form-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="werkstatt-modal-head">
          <div className="werkstatt-modal-title-block">
            <span className="werkstatt-modal-eyebrow">
              {de ? "WERKSTATT · TAXONOMIE" : "WORKSHOP · TAXONOMY"}
            </span>
            <h2 id="cat-form-title" className="werkstatt-modal-title">
              {mode === "create"
                ? (de ? "Neue Kategorie" : "New category")
                : (de ? "Kategorie bearbeiten" : "Edit category")}
            </h2>
          </div>
          <button
            type="button"
            className="werkstatt-modal-close"
            onClick={onClose}
            aria-label={de ? "Schließen" : "Close"}
          >
            ✕
          </button>
        </header>

        <div className="werkstatt-modal-body werkstatt-modal-body--stacked">
          <label className="werkstatt-field">
            <span className="werkstatt-field-label">
              {de ? "Bezeichnung" : "Name"} *
            </span>
            <input
              type="text"
              className="werkstatt-field-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={de ? "z. B. Druckluftwerkzeug" : "e.g. Pneumatic tools"}
              autoFocus
              maxLength={255}
            />
          </label>

          <label className="werkstatt-field">
            <span className="werkstatt-field-label">
              {de ? "Übergeordnete Kategorie" : "Parent category"}
            </span>
            <select
              className="werkstatt-field-select"
              value={parentId ?? ""}
              onChange={(event) =>
                setParentId(event.target.value === "" ? null : event.target.value)
              }
            >
              <option value="">
                {de ? "Oberste Ebene (Hauptkategorie)" : "Top level (main category)"}
              </option>
              {topLevelOptions
                .filter((opt) => opt.id !== initial.id) /* can't be its own parent */
                .map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.name}
                  </option>
                ))}
            </select>
          </label>

          <label className="werkstatt-field">
            <span className="werkstatt-field-label">
              {de ? "Notizen (optional)" : "Notes (optional)"}
            </span>
            <textarea
              className="werkstatt-field-textarea"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={3}
              placeholder={
                de
                  ? "Hinweise zur Verwendung, typische Artikel, Pflege…"
                  : "Usage notes, typical items, care…"
              }
            />
          </label>
        </div>

        <footer className="werkstatt-modal-foot">
          {mode === "edit" && onArchive && (
            <button
              type="button"
              className="werkstatt-action-btn werkstatt-action-btn--danger"
              onClick={onArchive}
            >
              {de ? "Archivieren" : "Archive"}
            </button>
          )}
          <div className="werkstatt-modal-foot-actions">
            <button type="button" className="werkstatt-action-btn" onClick={onClose}>
              {de ? "Abbrechen" : "Cancel"}
            </button>
            <button
              type="button"
              className="werkstatt-action-btn werkstatt-action-btn--primary"
              onClick={handleSave}
              disabled={!canSave}
            >
              {mode === "create"
                ? (de ? "Kategorie anlegen" : "Create category")
                : (de ? "Änderungen speichern" : "Save changes")}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
