/**
 * Inline editor of a hand-added line: its quantity and its note. The label
 * and the article stay as they are — a different thing is a different line
 * (remove it, add the other one).
 */
import { useState, type FormEvent } from "react";

import { MANUAL_NOTE_MAX, MANUAL_QUANTITY_MAX, parseManualQuantity } from "./manualQuantity";
import type { PanelMaterialLine, PanelMaterialManualUpdate } from "../../types/schaltplan";
import type { MaterialTexts } from "./panelMaterialTexts";

type Props = {
  line: PanelMaterialLine;
  t: MaterialTexts;
  busy: boolean;
  onSave: (body: PanelMaterialManualUpdate) => void | Promise<void>;
  onCancel: () => void;
};

export function PanelMaterialManualEditor({ line, t, busy, onSave, onCancel }: Props) {
  const [quantity, setQuantity] = useState(String(line.planned));
  const [note, setNote] = useState(line.note ?? "");
  const parsed = parseManualQuantity(quantity);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (parsed === null || busy) return;
    // An empty note clears it on the server.
    void onSave({ quantity: parsed, note: note.trim() });
  };

  return (
    <form className="sp-mat-form sp-mat-manual-edit" aria-label={t.editManualForm(line.label)} onSubmit={submit}>
      <div className="sp-mat-form-fields">
        <label className="sp-mat-field sp-mat-field--qty">
          <span>{t.quantity}</span>
          <input
            type="number"
            className="sp-mat-input"
            inputMode="numeric"
            min={1}
            max={MANUAL_QUANTITY_MAX}
            step={1}
            value={quantity}
            aria-invalid={parsed === null}
            autoFocus
            onChange={(event) => setQuantity(event.target.value)}
          />
        </label>
        <label className="sp-mat-field sp-mat-field--note">
          <span>{t.note}</span>
          <input
            type="text"
            className="sp-mat-input"
            maxLength={MANUAL_NOTE_MAX}
            placeholder={t.notePlaceholder}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        <div className="sp-mat-form-actions">
          <button type="submit" className="sp-btn sp-btn--primary" disabled={busy || parsed === null}>
            {t.save}
          </button>
          <button type="button" className="sp-btn sp-btn--ghost" onClick={onCancel}>
            {t.cancel}
          </button>
        </div>
      </div>
      {parsed === null && <small className="sp-mat-search-hint sp-mat-search-hint--error">{t.quantityInvalid}</small>}
    </form>
  );
}
