/**
 * The frame every sheet of the Schrank tab shares (docs/PANEL_ENCLOSURE.md
 * §11): head with ‹ (back to the sheet below), title and ×, an optional
 * toolbar that stays put while the body scrolls (the module picker's search,
 * docs/PANEL_ENCLOSURE_R4.md §8.1), a scrolling body, an optional action
 * row — and no backdrop of its own. The stack has
 * one backdrop (`SheetBackdrop`, rendered once by the tab), so a sheet
 * opened on top of another does not darken the screen twice and a tap
 * outside closes only the top sheet.
 *
 * Same `sp-sheet` bottom sheet as the device palette: on a tablet held in
 * the workshop the lower part of the screen is where the thumb is.
 */
import { useId, type ReactNode } from "react";

import "../../../styles/schaltplan-enclosure-sheets.css";

type FrameProps = {
  title: string;
  /** Second line under the title (article, rail capacity). */
  subtitle?: ReactNode;
  /** Shown when there is a sheet below to go back to. */
  onBack?: () => void;
  onClose: () => void;
  children: ReactNode;
  /** Between head and body, outside the scroller: what must stay in reach while the list scrolls. */
  toolbar?: ReactNode;
  /** The action row at the bottom (primary actions). */
  footer?: ReactNode;
  /** "alertdialog" for a question that must be answered (RegroupConfirm). */
  role?: "dialog" | "alertdialog";
  className?: string;
};

export function SheetFrame({ title, subtitle, onBack, onClose, children, toolbar, footer, role = "dialog", className }: FrameProps) {
  const titleId = useId();
  return (
    <div
      className={["sp-sheet", "sp-encl-sheet", className].filter(Boolean).join(" ")}
      role={role}
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div className="sp-sheet-head">
        {onBack ? (
          <button type="button" className="sp-sheet-nav sp-encl-target" onClick={onBack} aria-label="Zurück">
            ‹
          </button>
        ) : null}
        <div className="sp-encl-sheet-title">
          <h3 id={titleId}>{title}</h3>
          {subtitle ? <small>{subtitle}</small> : null}
        </div>
        <button type="button" className="sp-sheet-close sp-encl-target" onClick={onClose} aria-label="Schließen">
          ×
        </button>
      </div>
      {toolbar ? <div className="sp-encl-sheet-toolbar">{toolbar}</div> : null}
      <div className="sp-sheet-body">{children}</div>
      {footer ? <div className="sp-sheet-actions">{footer}</div> : null}
    </div>
  );
}

/** The stack's one backdrop: a tap pops the top sheet. */
export function SheetBackdrop({ onDismiss }: { onDismiss: () => void }) {
  return <div className="sp-sheet-backdrop" onClick={onDismiss} aria-hidden="true" />;
}

/** A titled block inside a sheet body; a landmark, so tests and screen readers can find it by name. */
export function SheetSection({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  const headingId = useId();
  return (
    <section className={["sp-palette-section", "sp-encl-section", className].filter(Boolean).join(" ")} aria-labelledby={headingId}>
      <h4 id={headingId}>{title}</h4>
      {children}
    </section>
  );
}

/**
 * The catalogue's "not fully checked" flag (§3.1 `verified: false`); `title`
 * says what is unchecked elsewhere ("Automatisch ergänzt": derived from the
 * drawing, docs/PANEL_ENCLOSURE_R4.md §8.4).
 */
export function UnverifiedBadge({ title = "Katalogdaten nicht vollständig geprüft" }: { title?: string } = {}) {
  return (
    <span className="sp-encl-badge sp-encl-badge--unverified" title={title}>
      ungeprüft
    </span>
  );
}

type ConfirmProps = {
  question: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** "Abbrechen" unless the sheet has an "Abbrechen" of its own that means the opposite. */
  cancelLabel?: string;
};

/** A destructive step asked in place — no browser `confirm()`, which a kiosk tablet may suppress. */
export function ConfirmStrip({ question, confirmLabel, onConfirm, onCancel, cancelLabel = "Abbrechen" }: ConfirmProps) {
  return (
    <div className="sp-encl-confirm" role="group" aria-label={question}>
      <p>{question}</p>
      <div className="sp-encl-confirm-actions">
        <button type="button" className="sp-btn sp-btn--armed sp-encl-target" onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button type="button" className="sp-btn sp-encl-target" onClick={onCancel}>
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}
