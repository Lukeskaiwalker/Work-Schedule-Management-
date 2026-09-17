import { useState } from "react";

import { AmountStepper } from "../AmountStepper";
import { unitLabel } from "../unitLabel";
import type { ReturnCondition } from "../../../utils/werkstattMobileApi";

/**
 * MobileReturnSheet — "Zurückgeben" confirmation for the phone screens.
 *
 * `POST /werkstatt/mobile/return` needs three things the button cannot know:
 * HOW MANY came back, in what CONDITION, and WHICH loan is being closed. A
 * one-tap "Zurück" that assumed the whole quantity in working order would
 * write the wrong number into the ledger every time an electrician brings back
 * three of five, and would quietly book a broken tool back onto the shelf as
 * available.
 *
 * So the button opens this, and it stays deliberately small: quantity seeded
 * at everything the CALLER has out on the chosen loan, three condition cards
 * with van-sized targets, and an optional note.
 *
 * ── Why `targets` and not one quantity ───────────────────────────────────
 *
 * The server balances an open loan per `(article, project)`, so a return has
 * to name the bucket it belongs to or it closes nothing (see `ReturnInput
 * .projectId`). The home screen hands over the one row the user tapped; the
 * article screen can hold several loans of the same article — one per project
 * — and lets the user pick, because guessing would book the return against
 * somebody else's job number.
 *
 * Every quantity in here is the caller's OWN outstanding amount. The article's
 * team-wide `stock_out` must never be handed in as the cap: seeded with it,
 * two taps booked thirteen drums still in a colleague's van back onto the
 * shelf, and the server could not refuse it because it only checks the
 * article's global total.
 *
 * Presentational — the host page owns the request and feeds `submitting` and
 * `error` back, so a rejected return keeps what the user picked.
 */

/** One open loan of this article that the CALLER is still holding. */
export interface MobileReturnTarget {
  /** The loan's project, or null when it was booked against none. */
  project_id: number | null;
  /** What to call it on screen — project number, else name. */
  project_label: string | null;
  /** How many the caller still has out in THIS bucket — the cap. */
  quantity_out: number;
}

export interface MobileReturnSheetProps {
  open: boolean;
  onClose: () => void;
  language: "de" | "en";
  item: {
    article_name: string;
    article_number: string;
    unit: string | null;
  };
  /**
   * The caller's own open loans of this article, newest-irrelevant order.
   * Empty means there is nothing this user can give back — the hosts gate on
   * that before opening the sheet, and the sheet says so rather than offering
   * a confirm button that can only be refused.
   */
  targets: ReadonlyArray<MobileReturnTarget>;
  submitting?: boolean;
  error?: string | null;
  onConfirm: (payload: {
    quantity: number;
    condition: ReturnCondition;
    notes: string;
    /** The loan being closed — straight from the chosen target. */
    project_id: number | null;
  }) => void;
}

interface ConditionCard {
  key: ReturnCondition;
  title_de: string;
  title_en: string;
  hint_de: string;
  hint_en: string;
}

/* The hints name what the SERVER does with each choice. "Verloren" shrinks
 * total stock permanently, and somebody tapping it in a van deserves to read
 * that before they do, not afterwards. */
const CONDITIONS: ReadonlyArray<ConditionCard> = [
  {
    key: "ok",
    title_de: "In Ordnung",
    title_en: "In order",
    hint_de: "Zurück ins Lager, sofort wieder verfügbar",
    hint_en: "Back on the shelf, available again",
  },
  {
    key: "repair",
    title_de: "Defekt",
    title_en: "Faulty",
    hint_de: "Geht in Reparatur, nicht verfügbar",
    hint_en: "Goes into repair, not available",
  },
  {
    key: "lost",
    title_de: "Verloren",
    title_en: "Lost",
    hint_de: "Wird aus dem Gesamtbestand ausgebucht",
    hint_en: "Written off the total stock",
  },
];

/** The project caption of a loan, or the wording for one without a project. */
function targetLabel(target: MobileReturnTarget, de: boolean): string {
  return target.project_label ?? (de ? "Ohne Projekt" : "No project");
}

export function MobileReturnSheet({
  open,
  onClose,
  language,
  item,
  targets,
  submitting = false,
  error = null,
  onConfirm,
}: MobileReturnSheetProps) {
  const [selected, setSelected] = useState(0);
  const [condition, setCondition] = useState<ReturnCondition>("ok");
  const [notes, setNotes] = useState("");

  // A target list that shrank under an open sheet (a reload after a partial
  // return) must not leave the selection pointing past its end.
  const index = selected < targets.length ? selected : 0;
  const target = targets.length > 0 ? targets[index] : null;
  const out = Math.max(0, target?.quantity_out ?? 0);

  const [quantity, setQuantity] = useState<number | null>(out > 0 ? out : 0);

  // Re-seeding here rather than in an effect keeps the two in one update:
  // switching loans while the old quantity lingers is how a 3-of-3 return of
  // one project ends up sent against another that only has 1 out.
  const chooseTarget = (next: number) => {
    const picked = targets[next];
    if (!picked) return;
    setSelected(next);
    setQuantity(picked.quantity_out > 0 ? picked.quantity_out : 0);
  };

  if (!open) return null;

  const de = language === "de";
  const unit = unitLabel(item.unit, de);
  // Nothing dismisses the sheet mid-request: vanishing here would leave the
  // user unsure whether the stock moved.
  const dismiss = () => {
    if (submitting) return;
    onClose();
  };
  const blocked =
    target === null || quantity === null || quantity < 1 || quantity > out || submitting;

  return (
    <div className="werkstatt-modal-backdrop" role="presentation" onClick={dismiss}>
      <div
        className="werkstatt-modal werkstatt-mobile-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={de ? "Artikel zurückgeben" : "Return item"}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="werkstatt-modal-head">
          <div>
            <span className="werkstatt-sub-breadcrumb">
              {de ? "RÜCKGABE AN DIE WERKSTATT" : "RETURN TO THE WORKSHOP"}
            </span>
            <h2 className="werkstatt-modal-title">
              {de ? "Zurückgeben" : "Return item"}
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
            <span className="werkstatt-modal-hero-main">
              <b>{item.article_name}</b>
              <small>
                {item.article_number}
                {target ? ` · ${targetLabel(target, de)}` : ""}
              </small>
            </span>
            {/* "auf deinen Namen", not a bare "unterwegs": the article's
                team-wide figure is a different number, and confusing the two
                is what booked colleagues' tools back onto the shelf. */}
            <span className="werkstatt-stock-pill werkstatt-stock-pill--out">
              <span className="werkstatt-stock-pill-dot" aria-hidden="true" />
              {out} {unit} {de ? "auf deinen Namen" : "out under your name"}
            </span>
          </div>

          {target === null && (
            <div className="werkstatt-mobile-state" role="status">
              <b>
                {de
                  ? "Nichts auf deinen Namen unterwegs"
                  : "Nothing out under your name"}
              </b>
              <small>
                {de
                  ? "Zu diesem Artikel ist auf deinen Namen keine Entnahme offen — es gibt also nichts zurückzugeben."
                  : "You have no open checkout for this item, so there is nothing to give back."}
              </small>
            </div>
          )}

          {targets.length > 1 && (
            <div className="werkstatt-field">
              <span className="werkstatt-field-label">
                {de ? "Welche Entnahme?" : "Which checkout?"}
              </span>
              <div
                className="werkstatt-mobile-condition-row"
                role="radiogroup"
                aria-label={de ? "Welche Entnahme?" : "Which checkout?"}
              >
                {targets.map((option, idx) => {
                  const active = idx === index;
                  return (
                    <button
                      key={`${option.project_id ?? "none"}`}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      disabled={submitting}
                      className={`werkstatt-mobile-condition${
                        active ? " werkstatt-mobile-condition--active" : ""
                      }`}
                      onClick={() => chooseTarget(idx)}
                    >
                      <b>{targetLabel(option, de)}</b>
                      <small>
                        {option.quantity_out} {unit} {de ? "unterwegs" : "out"}
                      </small>
                    </button>
                  );
                })}
              </div>
              {/* The ledger balances per project; a return booked against the
                  wrong one leaves both loans wrong. */}
              <p className="werkstatt-modal-hint">
                {de
                  ? "Die Rückgabe wird auf diese Entnahme gebucht."
                  : "The return is booked against this checkout."}
              </p>
            </div>
          )}

          <div className="werkstatt-field">
            <span className="werkstatt-field-label">
              {de ? "Menge zurück" : "Quantity returned"}
            </span>
            <AmountStepper
              value={quantity}
              onChange={setQuantity}
              fallback={out > 0 ? out : 0}
              min={out > 0 ? 1 : 0}
              max={out}
              disabled={submitting}
              label={de ? "Menge zurück" : "Quantity returned"}
              decrementLabel={de ? "Weniger" : "Less"}
              incrementLabel={de ? "Mehr" : "More"}
            />
          </div>

          {quantity !== null && quantity > out && (
            <p className="werkstatt-modal-hint">
              {de
                ? `Nur ${out} auf deinen Namen unterwegs.`
                : `Only ${out} are out under your name.`}
            </p>
          )}

          <div className="werkstatt-field">
            <span className="werkstatt-field-label">{de ? "Zustand" : "Condition"}</span>
            <div className="werkstatt-mobile-condition-row" role="radiogroup">
              {CONDITIONS.map((card) => {
                const active = condition === card.key;
                return (
                  <button
                    key={card.key}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={submitting}
                    className={`werkstatt-mobile-condition${
                      active ? " werkstatt-mobile-condition--active" : ""
                    }`}
                    onClick={() => setCondition(card.key)}
                  >
                    <b>{de ? card.title_de : card.title_en}</b>
                    <small>{de ? card.hint_de : card.hint_en}</small>
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
                de ? "Was ist mit dem Artikel passiert?…" : "What happened to the item?…"
              }
              rows={2}
            />
          </label>

          {error && (
            <p className="werkstatt-modal-error" role="alert">
              {error}
            </p>
          )}
        </div>

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
                if (quantity === null || target === null) return;
                onConfirm({
                  quantity,
                  condition,
                  notes,
                  project_id: target.project_id,
                });
              }}
            >
              {submitting
                ? de
                  ? "Wird gebucht…"
                  : "Booking…"
                : de
                  ? "Rückgabe bestätigen"
                  : "Confirm return"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
