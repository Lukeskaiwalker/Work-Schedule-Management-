import { useState } from "react";

/**
 * EntnehmenModal — "Artikel entnehmen" dialog. Ported from Paper 9XE-0.
 * Shows the item hero, quantity stepper, project picker, expected-return
 * chip row, and an optional notes field. Emits a CheckoutPayload-shaped
 * object via `onConfirm`.
 *
 * Pure presentational — the host page controls visibility and dispatch.
 */
export type ReturnOption = "tonight" | "tomorrow" | "friday" | "custom";

export interface EntnehmenModalProps {
  open: boolean;
  onClose: () => void;
  language: "de" | "en";
  article: {
    item_name: string;
    article_number: string;
    location_name: string | null;
    stock_available: number;
    stock_total: number;
  };
  projects: ReadonlyArray<{ id: string; number: string; title: string }>;
  onConfirm: (payload: {
    quantity: number;
    project_id: string | null;
    expected_return: ReturnOption | null;
    notes: string;
  }) => void;
}

export function EntnehmenModal({
  open,
  onClose,
  language,
  article,
  projects,
  onConfirm,
}: EntnehmenModalProps) {
  const [quantity, setQuantity] = useState(1);
  const [projectId, setProjectId] = useState<string | null>(projects[0]?.id ?? null);
  const [returnOption, setReturnOption] = useState<ReturnOption | null>("friday");
  const [notes, setNotes] = useState("");

  if (!open) return null;

  const de = language === "de";

  return (
    <div className="werkstatt-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="werkstatt-modal"
        role="dialog"
        aria-modal="true"
        aria-label={de ? "Artikel entnehmen" : "Check out item"}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="werkstatt-modal-head">
          <div>
            <span className="werkstatt-sub-breadcrumb">
              {de ? "ENTNAHME AUS DER WERKSTATT" : "WORKSHOP CHECKOUT"}
            </span>
            <h2 className="werkstatt-modal-title">
              {de ? "Artikel entnehmen" : "Check out item"}
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

        <div className="werkstatt-modal-body">
          <div className="werkstatt-modal-hero">
            <span className="werkstatt-modal-hero-thumb" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path
                  d="M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Z"
                  stroke="#5C7895"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="werkstatt-modal-hero-main">
              <b>{article.item_name}</b>
              <small>
                {article.article_number}
                {article.location_name ? ` · Werkzeugwand · ${article.location_name}` : ""}
              </small>
            </span>
            <span className="werkstatt-stock-pill werkstatt-stock-pill--available">
              <span className="werkstatt-stock-pill-dot" aria-hidden="true" />
              {article.stock_available} / {article.stock_total}{" "}
              {de ? "verfügbar" : "available"}
            </span>
          </div>

          <div className="werkstatt-field-row">
            <label className="werkstatt-field">
              <span className="werkstatt-field-label">{de ? "Menge" : "Quantity"}</span>
              <div className="werkstatt-stepper">
                <button
                  type="button"
                  onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                  aria-label="−"
                >
                  −
                </button>
                <span className="werkstatt-stepper-value">{quantity}</span>
                <button
                  type="button"
                  onClick={() => setQuantity((q) => Math.min(article.stock_available, q + 1))}
                  aria-label="+"
                >
                  +
                </button>
              </div>
            </label>
            <label className="werkstatt-field werkstatt-field--grow">
              <span className="werkstatt-field-label">
                {de ? "Für Projekt" : "For project"}
              </span>
              <select
                className="werkstatt-field-select"
                value={projectId ?? ""}
                onChange={(event) => setProjectId(event.target.value || null)}
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.number} — {p.title}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="werkstatt-field">
            <span className="werkstatt-field-label">
              {de ? "Erwartete Rückgabe" : "Expected return"}
            </span>
            <div className="werkstatt-pill-row" role="radiogroup">
              {(["tonight", "tomorrow", "friday", "custom"] as const).map((option) => {
                const label = optionLabel(option, de);
                const active = returnOption === option;
                return (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`werkstatt-pill${active ? " werkstatt-pill--active" : ""}`}
                    onClick={() => setReturnOption(option)}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <label className="werkstatt-field">
            <span className="werkstatt-field-label">
              {de ? "Notiz (optional)" : "Notes (optional)"}
            </span>
            <textarea
              className="werkstatt-field-textarea"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder={
                de
                  ? "Hinweise für die Übernahme oder den Zustand…"
                  : "Notes about handover or condition…"
              }
              rows={2}
            />
          </label>

          <div className="werkstatt-hint-card">
            <span className="werkstatt-hint-icon" aria-hidden="true">⌘</span>
            <span className="werkstatt-hint-main">
              <b>{de ? "Schneller: per QR scannen" : "Faster: scan a QR code"}</b>
              <small>
                {de
                  ? "Artikel-QR mit dem Handy scannen, Projekt wird automatisch zugeordnet."
                  : "Scan the article QR from the phone — the project is auto-assigned."}
              </small>
            </span>
          </div>
        </div>

        <footer className="werkstatt-modal-foot">
          <small className="muted">
            {de ? "Angemeldet als" : "Signed in as"} Luca Schmidt
          </small>
          <div className="werkstatt-modal-foot-actions">
            <button type="button" className="werkstatt-action-btn" onClick={onClose}>
              {de ? "Abbrechen" : "Cancel"}
            </button>
            <button
              type="button"
              className="werkstatt-action-btn werkstatt-action-btn--primary"
              onClick={() =>
                onConfirm({
                  quantity,
                  project_id: projectId,
                  expected_return: returnOption,
                  notes,
                })
              }
            >
              → {de ? "Entnahme bestätigen" : "Confirm checkout"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function optionLabel(option: ReturnOption, de: boolean): string {
  if (option === "tonight") return de ? "Heute Abend" : "Tonight";
  if (option === "tomorrow") return de ? "Morgen" : "Tomorrow";
  if (option === "friday") return de ? "Freitag, 19. Apr" : "Friday, 19 Apr";
  return de ? "Datum…" : "Date…";
}
