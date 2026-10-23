/**
 * The drop note and its one-step Rückgängig (docs/PANEL_ENCLOSURE_R2.md
 * §6.5, R10).
 *
 * `run` applies an op with ONE `mutate` — on the drop, never on a pointer
 * move — and keeps the board before and after it. A refusal changes
 * nothing and says why; a drop that changed nothing says nothing.
 * `remember` does the same for an op the op runner already applied (a
 * finding's "Vorschlag ausführen", after its confirmation).
 *
 * Undo is identity-based: `mutate(c => c === after ? before : c)`. That
 * holds because the editor returns early on an unchanged board, re-uses a
 * clean board through `normalizeEnclosure`, and never adopts the server's
 * copy after an autosave — so the board on screen is still `after` until
 * someone edits it. Any later edit makes it another board: the note goes,
 * and so does Rückgängig. Undo is one step only.
 */
import { useCallback, useState } from "react";

import { UNDONE_TEXT } from "./dropNoteText";
import type { EditDocument } from "./useSheetStack";
import type { DropResult } from "../../../utils/enclosureOpsDrag";
import type { OpResult } from "../../../utils/enclosureOps";
import type { PanelDocument } from "../../../types/schaltplan";

export interface DropNoteView {
  lines: string[];
  canUndo: boolean;
}

export interface DropUndo {
  note: DropNoteView | null;
  run(op: (current: PanelDocument) => DropResult | OpResult, describe: (before: PanelDocument, after: PanelDocument) => string[]): void;
  remember(before: PanelDocument, after: PanelDocument, lines: string[]): void;
  undo(): void;
  dismiss(): void;
}

interface NoteState {
  lines: string[];
  /** The note shows while this is the board on screen. */
  shownFor: PanelDocument | null;
  undo: { before: PanelDocument; after: PanelDocument } | null;
}

type Outcome = { refusal: string } | { before: PanelDocument; after: PanelDocument } | null;

export function useDropUndo(args: { document: PanelDocument | null; mutate: EditDocument }): DropUndo {
  const { document, mutate } = args;
  const [state, setState] = useState<NoteState | null>(null);

  const run = useCallback<DropUndo["run"]>(
    (op, describe) => {
      let outcome: Outcome = null;
      let shownFor: PanelDocument | null = null;
      mutate((current) => {
        shownFor = current;
        const result = op(current);
        if (!result.ok) {
          outcome = { refusal: result.error };
          return current;
        }
        if (result.document === current) return current;
        outcome = { before: current, after: result.document };
        return result.document;
      });
      const done = outcome as Outcome;
      if (!done) return;
      if ("refusal" in done) {
        setState({ lines: [done.refusal], shownFor, undo: null });
        return;
      }
      setState({ lines: describe(done.before, done.after), shownFor: done.after, undo: done });
    },
    [mutate],
  );

  const remember = useCallback<DropUndo["remember"]>((before, after, lines) => {
    setState({ lines, shownFor: after, undo: { before, after } });
  }, []);

  const undo = useCallback(() => {
    const target = state?.undo;
    if (!target) return;
    let reverted = false;
    mutate((current) => {
      if (current !== target.after) return current;
      reverted = true;
      return target.before;
    });
    if (reverted) setState({ lines: [UNDONE_TEXT], shownFor: target.before, undo: null });
  }, [mutate, state]);

  const dismiss = useCallback(() => setState(null), []);

  const visible = state !== null && document !== null && document === state.shownFor;
  const note = visible ? { lines: state.lines, canUndo: state.undo !== null && document === state.undo.after } : null;
  return { note, run, remember, undo, dismiss };
}
