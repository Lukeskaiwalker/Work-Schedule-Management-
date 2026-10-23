/**
 * The drop note on screen (docs/PANEL_ENCLOSURE_R2.md §6.5): a fixed bar at
 * the bottom, above the sheet backdrop, so it is seen under a 75dvh drawing
 * and over an open sheet alike. **Rückgängig** and × are 56 px targets
 * (gloves). The bar is a polite live region that stays mounted, so a new
 * note is announced once, when its text is set.
 *
 * While a note is up it tells the page its height (`data-sp-dropnote` and
 * `--sp-dropnote-h` on <html>), and schaltplan-enclosure-drag.css ends every
 * sheet above it: a sheet opened after a drop — RegroupConfirm, the device
 * palette, RailSheet — keeps its last actions reachable instead of under the
 * bar. A note that wraps or grows is measured again (ResizeObserver).
 *
 * Portaled to the body: no ancestor's transform or overflow can clip a
 * fixed bar there.
 */
import { useLayoutEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";

import type { DropNoteView } from "./useDropUndo";
import "../../../styles/schaltplan-enclosure-drag.css";

type Props = {
  note: DropNoteView | null;
  onUndo: () => void;
  onDismiss: () => void;
};

const LIFT_ATTRIBUTE = "data-sp-dropnote";
const LIFT_PROPERTY = "--sp-dropnote-h";
/** The height of every note on screen (two tabs may each hold one); the sheets end above the tallest. */
const noteHeights = new Map<symbol, number>();

function applyLift() {
  const root = document.documentElement;
  if (noteHeights.size === 0) {
    root.removeAttribute(LIFT_ATTRIBUTE);
    root.style.removeProperty(LIFT_PROPERTY);
    return;
  }
  root.setAttribute(LIFT_ATTRIBUTE, "");
  root.style.setProperty(LIFT_PROPERTY, `${Math.ceil(Math.max(...noteHeights.values()))}px`);
}

/** While `note` is up, the bar's height on <html>; gone with the note or the component. */
function useSheetLift(bar: RefObject<HTMLDivElement>, note: DropNoteView | null) {
  useLayoutEffect(() => {
    const element = bar.current;
    if (!note || !element) return undefined;
    const key = Symbol("drop-note");
    const measure = () => {
      noteHeights.set(key, element.getBoundingClientRect().height);
      applyLift();
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      noteHeights.delete(key);
      applyLift();
    };
  }, [bar, note]);
}

export function DropNote({ note, onUndo, onDismiss }: Props) {
  const bar = useRef<HTMLDivElement>(null);
  useSheetLift(bar, note);
  const region = (
    <div className="sp-encl-dropnote-region" role="status" aria-live="polite">
      {note ? (
        <div className="sp-encl-dropnote" ref={bar}>
          <p className="sp-encl-dropnote-text">
            {note.lines.map((line, i) => (
              <span key={`${i}:${line}`}>{line}</span>
            ))}
          </p>
          {note.canUndo ? (
            <button type="button" className="sp-btn sp-btn--primary sp-encl-target sp-encl-dropnote-undo" onClick={onUndo}>
              Rückgängig
            </button>
          ) : null}
          <button type="button" className="sp-btn sp-encl-target sp-encl-dropnote-close" aria-label="Hinweis schließen" onClick={onDismiss}>
            ×
          </button>
        </div>
      ) : null}
    </div>
  );
  return createPortal(region, document.body);
}
