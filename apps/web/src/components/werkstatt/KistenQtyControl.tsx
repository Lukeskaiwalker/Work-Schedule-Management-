/**
 * KistenQtyControl — − / number / + for one line of a Baustellenkiste.
 *
 * The number used to be a read-only span, so 40 Wago clamps or 25 m of cable
 * took one tap per piece and the owner asked to type it instead. − and + stay
 * for the quick correction; the number is now a field.
 *
 * Nothing is sent while typing. Enter or leaving the field commits; Escape,
 * an empty field or something that is not a whole number puts the line's
 * number back — an emptied field never deletes a line, only a typed 0 does,
 * the same way − does at 1. Every result leaves through `onSet`, the page's
 * one path for a line's count, so a typed number and a tap share the debounce,
 * the optimistic overlay and the snap-back on error.
 *
 * A barcode scanner types like a keyboard and ends with Enter, and on this
 * page it may do so while this field has focus. The page's scanner listener
 * (useBarcodeScanner, ignoreWhenTyping:false, capture phase on window) sees
 * the keystrokes first, recognises a scan by their speed, adds the article,
 * and marks the Enter as handled with preventDefault. An Enter that arrives
 * here already handled is that scan: the digits it left in the field are
 * dropped, never committed — but a number typed before them is, as Enter
 * would have done. Scanner keystrokes do not move focus, so nothing else
 * would ever commit it. The scan is told apart the listener's way: its own
 * run of fast keystrokes at the end of the field's text. A code that is NOT
 * recognised (a scanner slower than the listener's window, one that ends
 * with Tab, a paste) is caught by size instead — no crate line is longer
 * than the API's limit.
 *
 * Crate actions ("Übergabe buchen", "Alle Kisten", …) commit a number still
 * in its field first (`commitFocusedQuantity`): on iOS a tapped button does
 * not always take focus from it, and the number would be lost once the line
 * turns read-only or the crate closes.
 *
 * type=text + inputMode=numeric, as in AmountStepper: the number pad on
 * phones, and the raw text stays readable so "1,5" can be refused rather than
 * silently read as 15. No maxLength either: cutting a 13-digit code down to
 * its first digits could leave a plausible count.
 */
import { useRef, useState } from "react";

import { SCAN_INTER_CHAR_TIMEOUT_MS } from "../../hooks/useBarcodeScanner";

/**
 * The API's bound on a crate line (MAX_BOX_QUANTITY in
 * schemas/werkstatt_boxes.py). Past it the server answers 422, so the field
 * refuses first, with a reason that fits the likely cause.
 */
export const BOX_MAX_QUANTITY = 10_000;

const MAX_DIGITS = String(BOX_MAX_QUANTITY).length;
const WHOLE_NUMBER = /^\d+$/;
const INPUT_CLASS = "kisten-qty-input";

/** No keystrokes yet, or the last run ended with Enter. */
const NO_KEY_RUN = { keys: "", lastAt: Number.NEGATIVE_INFINITY };

/**
 * Commit a number still being typed into a line's field, the way leaving the
 * field does. For crate actions, which must not run ahead of it.
 */
export function commitFocusedQuantity(): void {
  const focused = document.activeElement;
  if (focused instanceof HTMLInputElement && focused.classList.contains(INPUT_CLASS)) focused.blur();
}

/**
 * The field's text as it was before a scan: `text` without the scanned
 * characters at its end. Null when it does not end with them (the cursor was
 * elsewhere) — then nothing is guessed.
 */
export function textBeforeScan(text: string | null, scanned: string): string | null {
  if (text === null || scanned === "" || !text.endsWith(scanned)) return null;
  return text.slice(0, text.length - scanned.length);
}

export type BoxQuantityEntry =
  | { kind: "quantity"; value: number }
  | { kind: "empty" }
  | { kind: "invalid" }
  | { kind: "too_large" };

/**
 * What the field's text means. More digits than the limit has counts as too
 * large even when the value is small: "000012" is a zero-padded code, not a
 * count anybody types.
 */
export function parseBoxQuantity(raw: string): BoxQuantityEntry {
  const text = raw.trim();
  if (text === "") return { kind: "empty" };
  if (!WHOLE_NUMBER.test(text)) return { kind: "invalid" };
  const value = Number.parseInt(text, 10);
  if (text.length > MAX_DIGITS || value > BOX_MAX_QUANTITY) return { kind: "too_large" };
  return { kind: "quantity", value };
}

type Hint = "too_large" | "invalid";

const HINTS: Record<Hint, { de: string; en: string }> = {
  too_large: {
    de: "Menge zu groß — Scan im Mengenfeld?",
    en: "Quantity too large — scanned into the quantity field?",
  },
  invalid: { de: "Nur ganze Zahlen", en: "Whole numbers only" },
};

export interface KistenQtyControlProps {
  /** The line's count as the page shows it — the optimistic value included. */
  value: number;
  unit: string | null;
  /** Names the field for a screen reader, so two lines are never confused. */
  itemName: string;
  language: "de" | "en";
  /** The one way a new count leaves this control; 0 removes the line. */
  onSet: (next: number) => void;
}

export function KistenQtyControl({ value, unit, itemName, language, onSet }: KistenQtyControlProps) {
  const de = language === "de";
  /** The field's text while somebody is typing; null shows `value`. */
  const [draft, setDraft] = useState<string | null>(null);
  const [hint, setHint] = useState<Hint | null>(null);
  // A number that moved under the field (a refetch, a scan that topped this
  // line up, a failed write snapping back) wins over a draft typed against the
  // old one: blur is not reliable on iOS when a button elsewhere is tapped,
  // so a forgotten draft could otherwise be committed much later.
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setDraft(null);
  }
  // Safari and Chrome can drop a focus-time selection on the mouseup that
  // follows; swallowing that one mouseup keeps "tap, type, replaced".
  const keepSelectionRef = useRef(false);
  // The newest run of keystrokes that came faster than a person types — the
  // scanner listener's own measure, so a run it took for a scan is this one.
  const keyRunRef = useRef(NO_KEY_RUN);

  function trackKey(key: string) {
    const now = performance.now();
    const run = keyRunRef.current;
    const continues = now - run.lastAt <= SCAN_INTER_CHAR_TIMEOUT_MS;
    keyRunRef.current = { keys: continues ? run.keys + key : key, lastAt: now };
  }

  /** `text` is what to take; null only drops the draft. */
  function commit(text: string | null) {
    setDraft(null);
    if (text === null) return;
    const entry = parseBoxQuantity(text);
    if (entry.kind === "quantity") {
      setHint(null);
      onSet(entry.value);
    } else {
      setHint(entry.kind === "empty" ? null : entry.kind);
    }
  }

  function step(delta: number) {
    // A typed but uncommitted number is what the person sees, so + counts on
    // from it (a tap on a button does not blur the field everywhere).
    const typed = draft === null ? null : parseBoxQuantity(draft);
    const base = typed?.kind === "quantity" ? typed.value : value;
    setDraft(null);
    setHint(null);
    onSet(Math.min(BOX_MAX_QUANTITY, Math.max(0, base + delta)));
  }

  return (
    <>
      <div className="kisten-qty">
        <button
          type="button"
          onClick={() => step(-1)}
          aria-label={de ? "Menge verringern" : "Decrease quantity"}
        >
          −
        </button>
        <label className="kisten-qty-value">
          <input
            className={INPUT_CLASS}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            enterKeyHint="done"
            autoComplete="off"
            aria-label={`${de ? "Menge" : "Quantity"} ${itemName}`}
            aria-invalid={hint !== null}
            value={draft ?? String(value)}
            onFocus={(event) => {
              keepSelectionRef.current = true;
              event.currentTarget.select();
            }}
            onMouseUp={(event) => {
              if (!keepSelectionRef.current) return;
              keepSelectionRef.current = false;
              event.preventDefault();
            }}
            onChange={(event) => {
              setDraft(event.target.value);
              setHint(null);
            }}
            onKeyDown={(event) => {
              if (event.key.length === 1) {
                trackKey(event.key);
                return;
              }
              if (event.key === "Escape") {
                setDraft(null);
                setHint(null);
                return;
              }
              if (event.key !== "Enter") return;
              const run = keyRunRef.current.keys;
              keyRunRef.current = NO_KEY_RUN;
              // Already handled: the page's scanner listener took this Enter
              // as the end of a scan and is adding that article. The run it
              // ended is the scan; whatever was typed before it is kept.
              if (event.nativeEvent.defaultPrevented) {
                commit(textBeforeScan(draft, run));
                return;
              }
              event.preventDefault();
              commit(draft);
            }}
            onBlur={() => {
              keepSelectionRef.current = false;
              commit(draft);
            }}
          />
          {unit ? <small>{unit}</small> : null}
        </label>
        <button
          type="button"
          onClick={() => step(+1)}
          aria-label={de ? "Menge erhöhen" : "Increase quantity"}
        >
          +
        </button>
      </div>
      {hint && (
        <p className="kisten-qty-hint" role="alert">
          {de ? HINTS[hint].de : HINTS[hint].en}
        </p>
      )}
    </>
  );
}
