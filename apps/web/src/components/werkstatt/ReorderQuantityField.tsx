/**
 * A quantity field that can be emptied.
 *
 * WHY it owns state at all: the basket holds numbers, and a half-typed field
 * is not a number. Feeding the parsed value straight back as `value` made an
 * empty field impossible — `Number.parseInt("")` is NaN, the write was
 * skipped, and React restored the old digits with the caret at the end. So
 * backspacing 100 to type 250 produced 1002, and that is the number the POST
 * would have carried: the server accepts any integer ≥ 1, and 1002 m of cable
 * looks like a plausible order.
 *
 * The raw text therefore lives here while the buyer types, and only a parsed
 * value ever reaches the basket. Leaving the field empty commits 0 on blur,
 * which the line then labels "wird nicht bestellt" — visible, and one
 * keystroke from being undone.
 */
import { useState } from "react";

export interface ReorderQuantityFieldProps {
  /** The committed quantity, as the basket holds it. */
  value: number;
  /** Accessible name — the article, so two lines are never confused. */
  label: string;
  className?: string;
  onCommit: (quantity: number) => void;
}

export function ReorderQuantityField({
  value,
  label,
  className = "werkstatt-stepper-input",
  onCommit,
}: ReorderQuantityFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  // A committed value that did not come from this field (the +/- steppers, a
  // reload) has to win over a draft the buyer left lying around — Safari does
  // not focus a button on click, so the blur below cannot be relied on.
  const [committed, setCommitted] = useState(value);
  if (committed !== value) {
    setCommitted(value);
    setDraft(null);
  }

  const commitIfNumber = (raw: string) => {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) return;
    // Negative quantities are not a thing to order; the basket clamps too.
    onCommit(Math.max(0, parsed));
  };

  return (
    <input
      type="number"
      className={className}
      inputMode="numeric"
      min={0}
      aria-label={label}
      value={draft ?? String(value)}
      onChange={(event) => {
        const raw = event.target.value;
        setDraft(raw);
        commitIfNumber(raw);
      }}
      onBlur={() => {
        // "" is a state of the keyboard, never a quantity. Committing 0 is the
        // honest reading of an emptied order field: do not order this line.
        if (draft !== null && Number.isNaN(Number.parseInt(draft, 10))) onCommit(0);
        setDraft(null);
      }}
    />
  );
}
