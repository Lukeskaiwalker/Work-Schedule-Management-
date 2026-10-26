/**
 * A length in metres as a fitter types it (docs/PANEL_ENCLOSURE_R4.md §8.2,
 * §8.4): a text field with the decimal keypad, the stored value shown with a
 * comma, the drawing's measure as placeholder. Parsed on blur and Enter, "," or
 * "." (`parseLengthText`): 0,5 … 20 m is stored (one decimal, half up), an
 * emptied field goes back to the drawing (null), anything else keeps the
 * stored value and says the range. Used by the §14a sheet ("Länge je Ader")
 * and the network lead in "Automatisch ergänzt".
 */
import { useId, useState, type KeyboardEvent } from "react";

import { parseLengthText } from "./controlBlockLayout";
import { formatMmText } from "../../../utils/enclosureGeometry";
import { CONTROL_LENGTH_INVALID } from "../../../utils/enclosureOpsControlBlock";

type Props = {
  label: string;
  /** Stored metres; null = from the drawing. */
  value: number | null;
  placeholder: string;
  disabled: boolean;
  onCommit: (metres: number | null) => void;
  className?: string;
};

export function LengthField({ label, value, placeholder, disabled, onCommit, className }: Props) {
  // null = not editing: the field shows the stored value.
  const [text, setText] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const hintId = useId();
  const commit = () => {
    if (text === null) return;
    const parsed = parseLengthText(text);
    setText(null);
    setInvalid(parsed.kind === "invalid");
    if (parsed.kind === "invalid") return;
    const next = parsed.kind === "empty" ? null : parsed.metres;
    if (next !== value) onCommit(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    commit();
  };
  return (
    <label className={["sp-field", className].filter(Boolean).join(" ")}>
      <span className="sp-field-label">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={text ?? (value === null ? "" : formatMmText(value))}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? hintId : undefined}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
      {invalid ? (
        <small id={hintId} className="sp-field-hint sp-encl-control-warn">
          {CONTROL_LENGTH_INVALID}
        </small>
      ) : null}
    </label>
  );
}
