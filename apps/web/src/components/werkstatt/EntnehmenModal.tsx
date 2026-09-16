import { useState } from "react";
import { AmountStepper } from "./AmountStepper";
import {
  returnOptionLabel,
  type ReturnOption,
} from "../../utils/werkstattReturnDates";

/**
 * EntnehmenModal — "Artikel entnehmen" dialog. Ported from Paper 9XE-0.
 * Shows the item hero, quantity stepper, project picker, expected-return
 * chip row, and an optional notes field. Emits a CheckoutPayload-shaped
 * object via `onConfirm`.
 *
 * The quantity is a real input rather than a read-only span between two
 * buttons — a workshop tablet should not need forty taps to take forty metres
 * of cable off the shelf.
 *
 * A checkout moves stock out of AVAILABLE, so every number here is about
 * available stock and the amount is capped at it. Taking more than is on the
 * shelf is not a request the server should have to refuse.
 *
 * Presentational: the host page owns the request, and passes `submitting` /
 * `error` back in. The dialog stays mounted on failure, so a rejected checkout
 * keeps the project, the date and the note the user already picked.
 */
export type { ReturnOption };

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
  submitting?: boolean;
  error?: string | null;
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
  submitting = false,
  error = null,
  onConfirm,
}: EntnehmenModalProps) {
  const available = Math.max(0, article.stock_available);
  // Opening on 1 is only honest when there is something to take.
  const [quantity, setQuantity] = useState<number | null>(available > 0 ? 1 : 0);
  // No project by default. Booking a checkout against whichever project
  // happened to sort first is worse than booking it against none, now that
  // the choice actually reaches the ledger.
  const [projectId, setProjectId] = useState<string | null>(null);
  const [returnOption, setReturnOption] = useState<ReturnOption | null>("friday");
  const [notes, setNotes] = useState("");

  if (!open) return null;

  const de = language === "de";
  // One instant for every chip, so the row cannot straddle midnight.
  const now = new Date();
  // A dialog that vanishes mid-request would leave the user unsure whether
  // the stock moved, so nothing dismisses it while the booking is in flight.
  const dismiss = () => {
    if (submitting) return;
    onClose();
  };
  const blocked = quantity === null || quantity < 1 || quantity > available || submitting;

  return (
    <div className="werkstatt-modal-backdrop" role="presentation" onClick={dismiss}>
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
            onClick={dismiss}
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
                {article.location_name ? ` · ${article.location_name}` : ""}
              </small>
            </span>
            <span
              className={`werkstatt-stock-pill werkstatt-stock-pill--${available > 0 ? "available" : "empty"}`}
            >
              <span className="werkstatt-stock-pill-dot" aria-hidden="true" />
              {available} / {article.stock_total} {de ? "verfügbar" : "available"}
            </span>
          </div>

          <div className="werkstatt-field-row">
            {/* A <div>, not a <label>: a label wrapping three controls (−, the
                number, +) names all of them. The input carries its own. */}
            <div className="werkstatt-field">
              <span className="werkstatt-field-label">{de ? "Menge" : "Quantity"}</span>
              <AmountStepper
                value={quantity}
                onChange={setQuantity}
                fallback={available > 0 ? 1 : 0}
                min={available > 0 ? 1 : 0}
                max={available}
                disabled={submitting}
                label={de ? "Menge" : "Quantity"}
                decrementLabel={de ? "Weniger" : "Less"}
                incrementLabel={de ? "Mehr" : "More"}
              />
            </div>
            <label className="werkstatt-field werkstatt-field--grow">
              <span className="werkstatt-field-label">
                {de ? "Für Projekt" : "For project"}
              </span>
              <select
                className="werkstatt-field-select"
                value={projectId ?? ""}
                disabled={submitting}
                onChange={(event) => setProjectId(event.target.value || null)}
              >
                <option value="">{de ? "Kein Projekt" : "No project"}</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.number} — {p.title}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {available === 0 && (
            <p className="werkstatt-modal-hint">
              {de
                ? "Nichts verfügbar — der komplette Bestand ist unterwegs oder in Reparatur."
                : "Nothing available — the whole stock is out or in repair."}
            </p>
          )}
          {quantity !== null && quantity > available && (
            <p className="werkstatt-modal-hint">
              {de
                ? `Nur ${available} verfügbar.`
                : `Only ${available} available.`}
            </p>
          )}

          <div className="werkstatt-field">
            <span className="werkstatt-field-label">
              {de ? "Erwartete Rückgabe" : "Expected return"}
            </span>
            <div className="werkstatt-pill-row" role="radiogroup">
              {(["tonight", "tomorrow", "friday", "custom"] as const).map((option) => {
                const active = returnOption === option;
                return (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={submitting}
                    className={`werkstatt-pill${active ? " werkstatt-pill--active" : ""}`}
                    onClick={() => setReturnOption(option)}
                  >
                    {returnOptionLabel(option, de, now)}
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
              disabled={submitting}
              onChange={(event) => setNotes(event.target.value)}
              placeholder={
                de
                  ? "Hinweise für die Übernahme oder den Zustand…"
                  : "Notes about handover or condition…"
              }
              rows={2}
            />
          </label>

          {error && (
            <p className="werkstatt-modal-error" role="alert">
              {error}
            </p>
          )}

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

        {/* --right because the footer lost its left-hand item: it used to read
            "Angemeldet als Luca Schmidt", hard-coded, for whoever was signed
            in. Better no name than one user's name shown to everyone. */}
        <footer className="werkstatt-modal-foot werkstatt-modal-foot--right">
          <div className="werkstatt-modal-foot-actions">
            <button
              type="button"
              className="werkstatt-action-btn"
              disabled={submitting}
              onClick={dismiss}
            >
              {de ? "Abbrechen" : "Cancel"}
            </button>
            <button
              type="button"
              className="werkstatt-action-btn werkstatt-action-btn--primary"
              disabled={blocked}
              onClick={() => {
                if (quantity === null) return;
                onConfirm({
                  quantity,
                  project_id: projectId,
                  expected_return: returnOption,
                  notes,
                });
              }}
            >
              {submitting
                ? de
                  ? "Wird gebucht…"
                  : "Booking…"
                : `→ ${de ? "Entnahme bestätigen" : "Confirm checkout"}`}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
