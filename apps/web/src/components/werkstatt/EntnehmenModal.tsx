import { useId, useState } from "react";
import { AmountStepper } from "./AmountStepper";
import {
  CONSUMPTION_MAX_QUANTITY,
  isConsumableArticle,
  type DispenseProjectOption,
} from "./dispense";
import {
  returnOptionLabel,
  type ReturnOption,
} from "../../utils/werkstattReturnDates";
import "../../styles/werkstatt-dispense.css";

/**
 * EntnehmenModal — taking an article off the shelf. Ported from Paper 9XE-0.
 *
 * Two shapes, because the ledger books two different things (owner,
 * 2026-10-10: "any item that is not inside the machine tab is a consumable"):
 *
 *   consumable (`is_serialized` false or absent) — "Material entnehmen". It is
 *     used up at a site and never comes back, so there is no return date, the
 *     project is the first question, and the amount is NOT capped at the
 *     shelf: the person is holding the part, so a short count was wrong, and
 *     the server books the shortfall up and says so (`stock_warning`).
 *   machine type (`is_serialized` true) — "Artikel entnehmen", a loan: capped
 *     at available stock, with an expected return date. Unchanged.
 *
 * The quantity is a real input rather than a read-only span between two
 * buttons — a workshop tablet should not need forty taps to take forty metres
 * of cable off the shelf.
 *
 * Presentational: the host page owns the request, and passes `submitting` /
 * `error` back in. The dialog stays mounted on failure, so a rejected booking
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
    /** True for a machine type (lent); false or absent for a consumable. */
    is_serialized?: boolean | null;
  };
  projects: ReadonlyArray<DispenseProjectOption>;
  submitting?: boolean;
  error?: string | null;
  onConfirm: (payload: {
    quantity: number;
    project_id: string | null;
    /** Always null for a consumable: nothing is expected back. */
    expected_return: ReturnOption | null;
    notes: string;
  }) => void;
}

function dialogTexts(consumable: boolean, de: boolean) {
  if (consumable) {
    return {
      eyebrow: de ? "VERBRAUCH AUS DEM LAGER" : "USED FROM STOCK",
      title: de ? "Material entnehmen" : "Take material",
      confirm: de ? "Entnehmen (Verbrauch)" : "Take (consumption)",
      noProject: de ? "Ohne Projekt" : "No project",
      notes: de ? "Wofür, z. B. Raum oder Verteiler…" : "What for, e.g. room or panel…",
      fasterTitle: de ? "Schneller: am Regal scannen" : "Faster: scan it at the rack",
      fasterText: de
        ? "Name antippen, Projekt wählen, Artikel scannen — wird genauso als Verbrauch gebucht."
        : "Tap your name, pick the project, scan the item — booked as used the same way.",
    };
  }
  return {
    eyebrow: de ? "ENTNAHME AUS DER WERKSTATT" : "WORKSHOP CHECKOUT",
    title: de ? "Artikel entnehmen" : "Check out item",
    confirm: de ? "Entnahme bestätigen" : "Confirm checkout",
    noProject: de ? "Kein Projekt" : "No project",
    notes: de ? "Hinweise für die Übernahme oder den Zustand…" : "Notes about handover or condition…",
    fasterTitle: de ? "Schneller: per QR scannen" : "Faster: scan a QR code",
    fasterText: de
      ? "Artikel-QR mit dem Handy scannen, Projekt wird automatisch zugeordnet."
      : "Scan the article QR from the phone — the project is auto-assigned.",
  };
}

function ProjectPicker({
  value,
  onChange,
  projects,
  noProjectLabel,
  disabled,
  de,
  prominent,
}: {
  value: string | null;
  onChange: (next: string | null) => void;
  projects: ReadonlyArray<DispenseProjectOption>;
  noProjectLabel: string;
  disabled: boolean;
  de: boolean;
  prominent: boolean;
}) {
  const hintId = useId();
  const field = (
    <label className="werkstatt-field werkstatt-field--grow">
      <span className="werkstatt-field-label">{de ? "Für Projekt" : "For project"}</span>
      <select
        className="werkstatt-field-select"
        value={value ?? ""}
        disabled={disabled}
        aria-describedby={prominent ? hintId : undefined}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">{noProjectLabel}</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.number} — {p.title}
          </option>
        ))}
      </select>
    </label>
  );
  if (!prominent) return field;
  return (
    <div className="werkstatt-dispense-project">
      {field}
      <small id={hintId} className="werkstatt-field-hint">
        {de
          ? "Wird als Verbrauch auf das Projekt gebucht — das Material kommt nicht zurück ins Lager."
          : "Booked as used on the project — the material does not come back to stock."}
      </small>
    </div>
  );
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
  const consumable = isConsumableArticle(article);
  const available = Math.max(0, article.stock_available);
  // A loan is capped at the shelf. A consumption is not: the server books a
  // short shelf up instead of refusing it, so its only cap is a sane maximum.
  const max = consumable ? CONSUMPTION_MAX_QUANTITY : available;
  // Opening on 1 is only honest when there is something to take — or when
  // taking it is allowed regardless, as for a consumable.
  const minimum = consumable || available > 0 ? 1 : 0;
  const [quantity, setQuantity] = useState<number | null>(minimum);
  // No project by default. Booking against whichever project happened to sort
  // first is worse than booking against none, now that the choice actually
  // reaches the ledger.
  const [projectId, setProjectId] = useState<string | null>(null);
  const [returnOption, setReturnOption] = useState<ReturnOption | null>("friday");
  const [notes, setNotes] = useState("");

  if (!open) return null;

  const de = language === "de";
  const texts = dialogTexts(consumable, de);
  // One instant for every chip, so the row cannot straddle midnight.
  const now = new Date();
  // A dialog that vanishes mid-request would leave the user unsure whether
  // the stock moved, so nothing dismisses it while the booking is in flight.
  const dismiss = () => {
    if (submitting) return;
    onClose();
  };
  const blocked = quantity === null || quantity < 1 || quantity > max || submitting;
  const shortfall = consumable && quantity !== null ? quantity - available : 0;

  const projectPicker = (
    <ProjectPicker
      value={projectId}
      onChange={setProjectId}
      projects={projects}
      noProjectLabel={texts.noProject}
      disabled={submitting}
      de={de}
      prominent={consumable}
    />
  );

  return (
    <div className="werkstatt-modal-backdrop" role="presentation" onClick={dismiss}>
      <div
        className="werkstatt-modal"
        role="dialog"
        aria-modal="true"
        aria-label={texts.title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="werkstatt-modal-head">
          <div>
            <span className="werkstatt-sub-breadcrumb">{texts.eyebrow}</span>
            <h2 className="werkstatt-modal-title">{texts.title}</h2>
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

          {/* Where it goes is the first question for material that stays there. */}
          {consumable && projectPicker}

          <div className="werkstatt-field-row">
            {/* A <div>, not a <label>: a label wrapping three controls (−, the
                number, +) names all of them. The input carries its own. */}
            <div className="werkstatt-field">
              <span className="werkstatt-field-label">{de ? "Menge" : "Quantity"}</span>
              <AmountStepper
                value={quantity}
                onChange={setQuantity}
                fallback={minimum}
                min={minimum}
                max={max}
                disabled={submitting}
                label={de ? "Menge" : "Quantity"}
                decrementLabel={de ? "Weniger" : "Less"}
                incrementLabel={de ? "Mehr" : "More"}
              />
            </div>
            {!consumable && projectPicker}
          </div>

          {consumable && shortfall > 0 && (
            <p className="werkstatt-modal-hint werkstatt-dispense-shortfall">
              {de
                ? `Laut Bestand nur ${available} da — die Differenz von ${shortfall} wird beim Buchen nachgebucht.`
                : `Stock shows only ${available} — the difference of ${shortfall} is booked in when you confirm.`}
            </p>
          )}
          {!consumable && available === 0 && (
            <p className="werkstatt-modal-hint">
              {de
                ? "Nichts verfügbar — der komplette Bestand ist unterwegs oder in Reparatur."
                : "Nothing available — the whole stock is out or in repair."}
            </p>
          )}
          {!consumable && quantity !== null && quantity > available && (
            <p className="werkstatt-modal-hint">
              {de ? `Nur ${available} verfügbar.` : `Only ${available} available.`}
            </p>
          )}

          {!consumable && (
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
          )}

          <label className="werkstatt-field">
            <span className="werkstatt-field-label">
              {de ? "Notiz (optional)" : "Notes (optional)"}
            </span>
            <textarea
              className="werkstatt-field-textarea"
              value={notes}
              disabled={submitting}
              onChange={(event) => setNotes(event.target.value)}
              placeholder={texts.notes}
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
              <b>{texts.fasterTitle}</b>
              <small>{texts.fasterText}</small>
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
                  expected_return: consumable ? null : returnOption,
                  notes,
                });
              }}
            >
              {submitting ? (de ? "Wird gebucht…" : "Booking…") : `→ ${texts.confirm}`}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
