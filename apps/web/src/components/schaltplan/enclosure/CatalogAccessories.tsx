/**
 * "Zubehör" of a catalogue entry (docs/PANEL_ENCLOSURE.md §3.1, §6, Q2):
 * the parts that go on the Materialliste of every board with this cabinet
 * or module — a field connector, an APZ socket — with how many per entry.
 * The owner decided the Werkstatt enters them, so they are plain rows here
 * rather than JSON: article number, name, quantity, checked or not.
 *
 * The quantity has − / + buttons beside the number: gloves on a workshop
 * tablet hit a 56 px button, not the spinner of a number input.
 */
import { useId } from "react";

import { SheetSection } from "./EnclosureSheetFrame";
import {
  ACCESSORIES_MAX,
  ACCESSORY_LABEL_MAX,
  ACCESSORY_QTY_MAX,
  ARTICLE_MAX,
  type AccessoryDraft,
} from "./catalogEntryDraft";
import "../../../styles/schaltplan-enclosure-admin.css";

type Props = {
  items: readonly AccessoryDraft[];
  disabled: boolean;
  onChange: (next: AccessoryDraft[]) => void;
};

const EMPTY: AccessoryDraft = { article_no: "", label: "", qty: 1, verified: true };

function Quantity({ value, disabled, onChange }: { value: number; disabled: boolean; onChange: (qty: number) => void }) {
  const id = useId();
  const known = Number.isFinite(value);
  return (
    <div className="sp-field sp-encl-admin-qty">
      <label className="sp-field-label" htmlFor={id}>
        Menge
      </label>
      <div className="sp-encl-admin-stepper">
        <button
          type="button"
          className="sp-btn sp-encl-target"
          aria-label="Menge verringern"
          disabled={disabled || !known || value <= 1}
          onClick={() => onChange(value - 1)}
        >
          −
        </button>
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={1}
          max={ACCESSORY_QTY_MAX}
          value={known ? value : ""}
          disabled={disabled}
          onChange={(event) => onChange(Number.parseInt(event.target.value, 10))}
        />
        <button
          type="button"
          className="sp-btn sp-encl-target"
          aria-label="Menge erhöhen"
          disabled={disabled || (known && value >= ACCESSORY_QTY_MAX)}
          onClick={() => onChange(known ? value + 1 : 1)}
        >
          +
        </button>
      </div>
    </div>
  );
}

function TextInput({ label, value, maxLength, disabled, onChange }: { label: string; value: string; maxLength: number; disabled: boolean; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <div className="sp-field">
      <label className="sp-field-label" htmlFor={id}>
        {label}
      </label>
      <input id={id} type="text" value={value} maxLength={maxLength} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

type RowProps = { item: AccessoryDraft; position: number; disabled: boolean; onPatch: (patch: Partial<AccessoryDraft>) => void; onRemove: () => void };

function AccessoryRow({ item, position, disabled, onPatch, onRemove }: RowProps) {
  const name = `Zubehör ${position}`;
  return (
    <li>
      <fieldset className="sp-encl-admin-accessory">
        <legend className="sp-encl-admin-legend">{name}</legend>
        <TextInput label="Artikelnummer" value={item.article_no} maxLength={ARTICLE_MAX} disabled={disabled} onChange={(article_no) => onPatch({ article_no })} />
        <TextInput label="Bezeichnung" value={item.label} maxLength={ACCESSORY_LABEL_MAX} disabled={disabled} onChange={(label) => onPatch({ label })} />
        <Quantity value={item.qty} disabled={disabled} onChange={(qty) => onPatch({ qty })} />
        <div className="sp-encl-admin-accessory-tail">
          <label className="sp-check sp-encl-target">
            <input type="checkbox" checked={item.verified} disabled={disabled} onChange={(event) => onPatch({ verified: event.target.checked })} />
            <span className="sp-check-text">geprüft</span>
          </label>
          <button type="button" className="sp-btn sp-btn--danger sp-encl-target" aria-label={`${name} entfernen`} disabled={disabled} onClick={onRemove}>
            Entfernen
          </button>
        </div>
      </fieldset>
    </li>
  );
}

export function CatalogAccessories({ items, disabled, onChange }: Props) {
  const patch = (at: number, change: Partial<AccessoryDraft>) => onChange(items.map((item, i) => (i === at ? { ...item, ...change } : item)));
  const remove = (at: number) => onChange(items.filter((_, i) => i !== at));
  return (
    <SheetSection title="Zubehör">
      <p className="sp-encl-hint">Steht bei jedem Plan mit diesem Eintrag auf der Materialliste — Menge je Schrank bzw. je Modul.</p>
      {items.length > 0 ? (
        <ul className="sp-encl-admin-accessories">
          {items.map((item, i) => (
            // Index keys are safe: every input is controlled from `items`.
            <AccessoryRow key={i} item={item} position={i + 1} disabled={disabled} onPatch={(change) => patch(i, change)} onRemove={() => remove(i)} />
          ))}
        </ul>
      ) : (
        <p className="sp-encl-empty">Kein Zubehör.</p>
      )}
      <button
        type="button"
        className="sp-btn sp-btn--ghost sp-encl-target"
        disabled={disabled || items.length >= ACCESSORIES_MAX}
        onClick={() => onChange([...items, { ...EMPTY }])}
      >
        + Zubehör
      </button>
    </SheetSection>
  );
}
