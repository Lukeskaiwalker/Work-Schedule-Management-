import { useCallback } from "react";

/**
 * AmountStepper — the − / number / + control used by the Werkstatt stock
 * dialogs.
 *
 * It replaces a read-only <span> that sat between the two buttons. On a
 * workshop tablet that meant a stock count of 240 took two hundred and forty
 * taps, which is why the workshop reported "we are not allowed to type a
 * number". The number is now a real input.
 *
 * Empty is a legal *intermediate* value: clearing the field to retype it must
 * not snap to 0 on the first keystroke, so `value` is `number | null` and the
 * caller renders its preview accordingly. `onBlur` commits — an empty field
 * falls back to `fallback`, anything else is clamped into [min, max]. Clamping
 * deliberately does NOT happen while typing: capping "12" to "3" mid-word
 * makes the field fight the user.
 *
 * type=text + inputMode=numeric rather than type=number: it raises the same
 * numeric keypad on iPad and Android, but keeps `event.target.value` readable
 * (a type=number input reports "" for "12e", so digits cannot be filtered) and
 * makes "-" impossible to enter at all.
 */
export interface AmountStepperProps {
  /** `null` while the field is momentarily empty during retyping. */
  value: number | null;
  onChange: (next: number | null) => void;
  /** Committed on blur when the field was left empty. */
  fallback: number;
  min: number;
  max?: number;
  /** Accessible name of the number input. */
  label: string;
  /** Non-interactive glyph in front of the number: "+", "−" or "=". */
  sign?: string | null;
  /** Renders the large variant used by "Bestand anpassen". */
  big?: boolean;
  disabled?: boolean;
  decrementLabel: string;
  incrementLabel: string;
}

const NON_DIGITS = /[^0-9]/g;
/** Six digits is past any plausible workshop count and stops paste bombs. */
const MAX_DIGITS = 6;

export function AmountStepper({
  value,
  onChange,
  fallback,
  min,
  max,
  label,
  sign,
  big,
  disabled,
  decrementLabel,
  incrementLabel,
}: AmountStepperProps) {
  const clamp = useCallback(
    (n: number): number => {
      const lifted = Math.max(min, n);
      return max == null ? lifted : Math.min(max, lifted);
    },
    [min, max],
  );

  // An empty field still has to step from somewhere; `fallback` is what the
  // caller would have committed on blur, so stepping agrees with blurring.
  const current = value ?? fallback;

  const step = useCallback(
    (by: number) => onChange(clamp(current + by)),
    [clamp, current, onChange],
  );

  return (
    <div
      className={`werkstatt-stepper${big ? " werkstatt-stepper--big" : ""}`}
      role="group"
    >
      <button
        type="button"
        className="werkstatt-stepper-btn"
        aria-label={decrementLabel}
        disabled={disabled || current <= min}
        onClick={() => step(-1)}
      >
        −
      </button>
      {sign ? (
        <span className="werkstatt-stepper-sign" aria-hidden="true">
          {sign}
        </span>
      ) : null}
      <input
        className="werkstatt-stepper-input"
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="off"
        maxLength={MAX_DIGITS}
        aria-label={label}
        disabled={disabled}
        value={value === null ? "" : String(value)}
        // One tap replaces the whole number instead of appending to it.
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => {
          const digits = event.target.value.replace(NON_DIGITS, "").slice(0, MAX_DIGITS);
          onChange(digits === "" ? null : Number(digits));
        }}
        onBlur={() => onChange(clamp(value ?? fallback))}
      />
      <button
        type="button"
        className="werkstatt-stepper-btn"
        aria-label={incrementLabel}
        disabled={disabled || (max != null && current >= max)}
        onClick={() => step(1)}
      >
        +
      </button>
    </div>
  );
}
