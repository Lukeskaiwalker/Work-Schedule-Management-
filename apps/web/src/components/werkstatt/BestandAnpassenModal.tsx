import { useMemo, useState } from "react";

/**
 * BestandAnpassenModal — "Bestand anpassen" dialog. Ported from Paper A29-0.
 * Three adjustment types (Wareneingang / Schwund / Inventur-Korrektur) are
 * presented as big radio cards. Caller receives a signed delta plus a
 * mandatory reason string.
 */
export type AdjustmentKind = "intake" | "defect" | "inventory";

export interface BestandAnpassenModalProps {
  open: boolean;
  onClose: () => void;
  language: "de" | "en";
  article: {
    item_name: string;
    article_number: string;
    category_name: string | null;
    stock_total: number;
    unit: string | null;
  };
  onConfirm: (payload: {
    kind: AdjustmentKind;
    delta: number;
    new_total: number;
    reason: string;
  }) => void;
}

export function BestandAnpassenModal({
  open,
  onClose,
  language,
  article,
  onConfirm,
}: BestandAnpassenModalProps) {
  const [kind, setKind] = useState<AdjustmentKind>("intake");
  const [amount, setAmount] = useState<number>(200);
  const [reason, setReason] = useState("");

  const { newTotal, signedLabel } = useMemo(() => {
    const sign = kind === "defect" ? -1 : kind === "intake" ? 1 : 0;
    const delta = kind === "inventory" ? amount - article.stock_total : sign * amount;
    const label =
      kind === "inventory"
        ? `= ${amount}`
        : (sign > 0 ? "+" : "−") + amount.toString();
    return { newTotal: article.stock_total + delta, signedLabel: label };
  }, [kind, amount, article.stock_total]);

  if (!open) return null;

  const de = language === "de";
  const unit = article.unit || (de ? "St." : "pcs");

  return (
    <div className="werkstatt-modal-backdrop" role="presentation" onClick={onClose}>
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
                {article.category_name ? ` · ${article.category_name}` : ""}
              </small>
            </span>
            <span className="werkstatt-modal-hero-stock">
              <span className="muted">{de ? "AKTUELL" : "CURRENT"}</span>
              <b>
                {article.stock_total} {unit}
              </b>
            </span>
          </div>

          <div className="werkstatt-field">
            <span className="werkstatt-field-label">
              {de ? "Art der Anpassung" : "Adjustment type"}
            </span>
            <div className="werkstatt-radio-grid" role="radiogroup">
              <AdjustmentCard
                active={kind === "intake"}
                onClick={() => setKind("intake")}
                tone="ok"
                glyph="+"
                title={de ? "Wareneingang" : "Intake"}
                sub={de ? "+ Bestand erhöhen" : "+ increase stock"}
              />
              <AdjustmentCard
                active={kind === "defect"}
                onClick={() => setKind("defect")}
                tone="warn"
                glyph="−"
                title={de ? "Schwund / Defekt" : "Loss / defect"}
                sub={de ? "− Bestand reduzieren" : "− decrease stock"}
              />
              <AdjustmentCard
                active={kind === "inventory"}
                onClick={() => setKind("inventory")}
                tone="info"
                glyph="✎"
                title={de ? "Inventur-Korrektur" : "Inventory adjust"}
                sub={de ? "= Absolutwert setzen" : "= set absolute value"}
              />
            </div>
          </div>

          <div className="werkstatt-field-row">
            <label className="werkstatt-field werkstatt-field--grow">
              <span className="werkstatt-field-label">
                {kind === "inventory"
                  ? de
                    ? "Neuer Bestand"
                    : "New stock"
                  : kind === "intake"
                    ? de
                      ? "Menge Zugang"
                      : "Intake amount"
                    : de
                      ? "Menge Abgang"
                      : "Decrease amount"}
              </span>
              <div className="werkstatt-stepper werkstatt-stepper--big">
                <button
                  type="button"
                  onClick={() => setAmount((a) => Math.max(0, a - 1))}
                  aria-label="−"
                >
                  −
                </button>
                <span className="werkstatt-stepper-value werkstatt-stepper-value--signed">
                  {signedLabel}
                </span>
                <button
                  type="button"
                  onClick={() => setAmount((a) => a + 1)}
                  aria-label="+"
                >
                  +
                </button>
              </div>
            </label>
            <div className="werkstatt-field werkstatt-new-stock-pill">
              <span className="werkstatt-field-label muted">
                {de ? "NEUER STAND" : "NEW TOTAL"}
              </span>
              <b>
                {newTotal} {unit}
              </b>
            </div>
          </div>

          <label className="werkstatt-field">
            <span className="werkstatt-field-label">
              {de ? "Begründung / Beleg" : "Reason / reference"}
              <span className="werkstatt-required">*</span>
            </span>
            <textarea
              className="werkstatt-field-textarea"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={
                de
                  ? "Wareneingang Lieferschein LS-2024-0157 · Contorion"
                  : "Intake delivery note LS-2024-0157 · Contorion"
              }
              rows={2}
            />
          </label>
        </div>

        <footer className="werkstatt-modal-foot werkstatt-modal-foot--right">
          <button type="button" className="werkstatt-action-btn" onClick={onClose}>
            {de ? "Abbrechen" : "Cancel"}
          </button>
          <button
            type="button"
            className="werkstatt-action-btn werkstatt-action-btn--primary"
            disabled={reason.trim() === ""}
            onClick={() => {
              const sign = kind === "defect" ? -1 : kind === "intake" ? 1 : 0;
              const delta =
                kind === "inventory" ? amount - article.stock_total : sign * amount;
              onConfirm({ kind, delta, new_total: newTotal, reason });
            }}
          >
            {de ? "Korrektur speichern" : "Save adjustment"}
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
