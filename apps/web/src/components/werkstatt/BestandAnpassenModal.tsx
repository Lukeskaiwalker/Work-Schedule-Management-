import { useState } from "react";
import { AmountStepper } from "./AmountStepper";
import {
  boundsFor,
  offShelfCount,
  previewAdjustment,
  seedAmountFor,
  type ArticleStock,
} from "./stockAdjustment";
import { unitLabel } from "./unitLabel";
import type { StockAdjustmentKind } from "../../utils/werkstattArticlesApi";

/**
 * BestandAnpassenModal — "Bestand anpassen" dialog. Ported from Paper A29-0.
 * Three adjustment types (Wareneingang / Schwund / Inventur-Korrektur) are
 * presented as big radio cards. Caller receives the raw amount plus the
 * preview it was shown and a mandatory reason string.
 *
 * Two things the workshop reported, and where they are answered:
 *
 *  - "the displayed number is not true to what the edit dialog says". The
 *    dialog used to be handed the constant 4. It now receives the article's
 *    real counters — and, because the list column shows AVAILABLE while this
 *    dialog moves the TOTAL, it names both figures instead of showing one
 *    number under a label that could mean either.
 *  - "we are not allowed to type a number". The amount is a real input
 *    (see AmountStepper), seeded per kind rather than at the mock's 200.
 *
 * Presentational: it owns the form, never the request. The host page runs the
 * call, feeds `submitting` and `error` back, and closes the dialog only on
 * success — so a rejected booking keeps everything the user typed.
 */
export type AdjustmentKind = StockAdjustmentKind;

export interface BestandAnpassenModalProps {
  open: boolean;
  onClose: () => void;
  language: "de" | "en";
  article: {
    item_name: string;
    article_number: string;
    category_name: string | null;
    stock_total: number;
    stock_available: number;
    unit: string | null;
  };
  /** True while the booking is in flight — blocks a double-tap. */
  submitting?: boolean;
  /** Server's rejection, shown verbatim; the fix differs per message. */
  error?: string | null;
  onConfirm: (payload: {
    kind: AdjustmentKind;
    /** What the user entered: pieces for intake/defect, the counted SHELF
     *  figure for inventory. Always positive — this is what the API wants. */
    amount: number;
    delta: number;
    /** The total the entry implies, and for `inventory` the number to send as
     *  `target_total`: the shelf count plus everything that is out or in
     *  repair. For the other two kinds it is simply the previewed total. */
    new_total: number;
    reason: string;
  }) => void;
}

export function BestandAnpassenModal({
  open,
  onClose,
  language,
  article,
  submitting = false,
  error = null,
  onConfirm,
}: BestandAnpassenModalProps) {
  const stock: ArticleStock = {
    stock_total: article.stock_total,
    stock_available: article.stock_available,
  };

  const [kind, setKind] = useState<AdjustmentKind>("intake");
  // null = the field is momentarily empty while being retyped.
  const [amount, setAmount] = useState<number | null>(() => seedAmountFor("intake", stock));
  const [reason, setReason] = useState("");

  // Plain calls, not useMemo: both are a handful of comparisons, and memoising
  // them would mean listing a freshly-built `stock` object as a dependency.
  const bounds = boundsFor(kind, stock);
  const preview = previewAdjustment(kind, amount, stock);

  /**
   * Switching kind re-seeds the amount.
   *
   * A 12 typed as "twelve pieces arrived" would otherwise silently become
   * "the shelf holds twelve in total" — the same digits meaning something
   * completely different, with no visible change to say so.
   */
  const selectKind = (next: AdjustmentKind) => {
    if (next === kind) return;
    setKind(next);
    setAmount(seedAmountFor(next, stock));
  };

  if (!open) return null;

  const de = language === "de";
  const unit = unitLabel(article.unit, de);
  const offShelf = offShelfCount(stock);
  /** True while the inventory field means "what is on the shelf" rather than
   *  "the total" — i.e. whenever the two are different numbers. */
  const countsShelfOnly = kind === "inventory" && offShelf > 0;
  // A dialog that vanishes mid-request would leave the user unsure whether
  // the stock moved, so nothing dismisses it while the booking is in flight.
  const dismiss = () => {
    if (submitting) return;
    onClose();
  };
  /* Out of bounds is checked HERE rather than left to the stepper's blur
   * clamp. Blur does not always fire first — tapping Save straight from the
   * field submits what is typed — so a 500 could be sent against a shelf
   * holding 9, and the only thing to show for it was a 400.
   *
   * Same pairing as EntnehmenModal: Save refuses, and the hint below names the
   * limit while the typed number is still on screen. The blur clamp stays, but
   * nothing depends on it having run. */
  const outOfBounds = amount !== null && (amount < bounds.min || amount > bounds.max);
  /** Names the field by what the person is being asked to look at, which for a
   *  stock-take is the shelf and not the total. */
  const amountLabel =
    kind === "inventory"
      ? countsShelfOnly
        ? de
          ? "Gezählter Regalbestand"
          : "Counted on shelf"
        : de
          ? "Neuer Gesamtbestand"
          : "New total stock"
      : kind === "intake"
        ? de
          ? "Menge Zugang"
          : "Intake amount"
        : de
          ? "Menge Abgang"
          : "Decrease amount";
  const blocked =
    reason.trim() === "" ||
    amount === null ||
    outOfBounds ||
    preview.delta === 0 ||
    submitting;

  return (
    <div className="werkstatt-modal-backdrop" role="presentation" onClick={dismiss}>
      <div
        className="werkstatt-modal werkstatt-modal--narrow"
        role="dialog"
        aria-modal="true"
        aria-label={de ? "Bestand anpassen" : "Adjust stock"}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="werkstatt-modal-head">
          <div>
            <span className="werkstatt-sub-breadcrumb">
              {de ? "MANUELLE BESTANDSKORREKTUR" : "MANUAL STOCK ADJUSTMENT"}
            </span>
            <h2 className="werkstatt-modal-title">
              {de ? "Bestand anpassen" : "Adjust stock"}
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
                {article.category_name ? ` · ${article.category_name}` : ""}
              </small>
            </span>
            {/* The label says GESAMT, not AKTUELL: the list column next door
                shows AVAILABLE, and "current" would read as either. */}
            <span className="werkstatt-modal-hero-stock">
              <span className="muted">{de ? "GESAMT" : "TOTAL"}</span>
              <b>
                {article.stock_total} {unit}
              </b>
              {offShelf > 0 && (
                <small className="werkstatt-modal-hero-stock-split">
                  {de
                    ? `davon ${article.stock_available} verfügbar`
                    : `${article.stock_available} of them available`}
                </small>
              )}
            </span>
          </div>

          {offShelf > 0 && (
            <p className="werkstatt-modal-hint">
              {/* The stock-take case is the dangerous one. Somebody at the
                  shelf with a clipboard can only count the shelf; asking them
                  for the TOTAL and taking their shelf figure at face value is
                  how three items on a van get written off. So the field asks
                  for the count, and says out loud what it is adding back. */}
              {kind === "inventory"
                ? de
                  ? `Bitte nur zählen, was im Regal liegt: +${offShelf} ${unit} unterwegs / in Reparatur zählen nicht mit und werden automatisch dazugerechnet.`
                  : `Count what is on the shelf only: +${offShelf} ${unit} out / in repair do not count and are added back automatically.`
                : de
                  ? `Die Anpassung wirkt auf den Gesamtbestand (${article.stock_total} ${unit}). In der Liste steht der verfügbare Bestand (${article.stock_available} ${unit}) — ${offShelf} ${unit} sind unterwegs oder in Reparatur.`
                  : `The adjustment applies to total stock (${article.stock_total} ${unit}). The list shows available stock (${article.stock_available} ${unit}) — ${offShelf} ${unit} are out or in repair.`}
            </p>
          )}

          <div className="werkstatt-field">
            <span className="werkstatt-field-label">
              {de ? "Art der Anpassung" : "Adjustment type"}
            </span>
            <div className="werkstatt-radio-grid" role="radiogroup">
              <AdjustmentCard
                active={kind === "intake"}
                onClick={() => selectKind("intake")}
                tone="ok"
                glyph="+"
                title={de ? "Wareneingang" : "Intake"}
                sub={de ? "+ Bestand erhöhen" : "+ increase stock"}
              />
              <AdjustmentCard
                active={kind === "defect"}
                onClick={() => selectKind("defect")}
                tone="warn"
                glyph="−"
                title={de ? "Schwund / Defekt" : "Loss / defect"}
                sub={de ? "− Bestand reduzieren" : "− decrease stock"}
              />
              <AdjustmentCard
                active={kind === "inventory"}
                onClick={() => selectKind("inventory")}
                tone="info"
                glyph="✎"
                title={de ? "Inventur-Korrektur" : "Inventory adjust"}
                sub={de ? "= Absolutwert setzen" : "= set absolute value"}
              />
            </div>
          </div>

          <div className="werkstatt-field-row">
            {/* A <div>, not a <label>: a label wrapping three controls (−, the
                number, +) names all of them. The input carries its own. */}
            <div className="werkstatt-field werkstatt-field--grow">
              <span className="werkstatt-field-label">{amountLabel}</span>
              <AmountStepper
                value={amount}
                onChange={setAmount}
                fallback={seedAmountFor(kind, stock)}
                min={bounds.min}
                max={bounds.max}
                sign={preview.sign}
                big
                disabled={submitting}
                label={kind === "inventory" ? amountLabel : de ? "Menge" : "Amount"}
                decrementLabel={de ? "Weniger" : "Less"}
                incrementLabel={de ? "Mehr" : "More"}
              />
            </div>
            <div className="werkstatt-field werkstatt-new-stock-pill">
              <span className="werkstatt-field-label muted">
                {de ? "NEUER GESAMTBESTAND" : "NEW TOTAL"}
              </span>
              {/* An empty field means "no amount yet", so the preview says so
                  rather than inventing a total the user never entered. */}
              <b>{amount === null ? "—" : `${preview.newTotal} ${unit}`}</b>
              {/* The pill shows the TOTAL while the field above holds a SHELF
                  count, so it spells out the sum rather than leaving the user
                  to wonder why the two numbers differ. */}
              {countsShelfOnly && amount !== null && (
                <small className="werkstatt-new-stock-pill-split">
                  {de
                    ? `${amount} im Regal + ${offShelf} unterwegs`
                    : `${amount} on shelf + ${offShelf} out`}
                </small>
              )}
            </div>
          </div>

          {/* Mirrors EntnehmenModal: the limit is stated while the number the
              user typed is still on screen, because Save is already refusing
              it and a silent rewrite would not explain why. */}
          {kind === "defect" && amount !== null && amount > bounds.max && (
            <p className="werkstatt-modal-hint">
              {de
                ? `Nur ${article.stock_available} ${unit} auf Lager — mehr kann nicht abgeschrieben werden.`
                : `Only ${article.stock_available} ${unit} on the shelf — no more can be written off.`}
            </p>
          )}

          {kind === "defect" && article.stock_available === 0 && (
            <p className="werkstatt-modal-hint">
              {de
                ? "Nichts im Regal, was abgeschrieben werden könnte. Ein verlorener Artikel, der unterwegs ist, wird bei der Rückgabe als „verloren“ gemeldet."
                : "Nothing on the shelf to write off. An item lost while checked out is reported as lost on return instead."}
            </p>
          )}

          <label className="werkstatt-field">
            <span className="werkstatt-field-label">
              {de ? "Begründung / Beleg" : "Reason / reference"}
              <span className="werkstatt-required">*</span>
            </span>
            <textarea
              className="werkstatt-field-textarea"
              value={reason}
              disabled={submitting}
              onChange={(event) => setReason(event.target.value)}
              placeholder={
                de
                  ? "Wareneingang Lieferschein LS-2024-0157 · Contorion"
                  : "Intake delivery note LS-2024-0157 · Contorion"
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
              if (amount === null) return;
              onConfirm({
                kind,
                amount,
                delta: preview.delta,
                new_total: preview.newTotal,
                reason: reason.trim(),
              });
            }}
          >
            {submitting
              ? de
                ? "Wird gebucht…"
                : "Booking…"
              : de
                ? "Korrektur speichern"
                : "Save adjustment"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function AdjustmentCard({
  active,
  onClick,
  tone,
  glyph,
  title,
  sub,
}: {
  active: boolean;
  onClick: () => void;
  tone: "ok" | "warn" | "info";
  glyph: string;
  title: string;
  sub: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      className={`werkstatt-radio-card werkstatt-radio-card--${tone}${active ? " werkstatt-radio-card--active" : ""}`}
      onClick={onClick}
    >
      <span className={`werkstatt-radio-glyph werkstatt-radio-glyph--${tone}`} aria-hidden="true">
        {glyph}
      </span>
      <b>{title}</b>
      <small>{sub}</small>
    </button>
  );
}
