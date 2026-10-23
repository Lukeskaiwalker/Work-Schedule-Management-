/**
 * Runs the cabinet ops the Schrank tab's sheets hand over
 * (docs/PANEL_ENCLOSURE.md D4, §2.4, §11; the `RunEnclosureOp` contract in
 * `useSheetStack.ts`).
 *
 * An op is a pure function of the board. It runs once to see what it
 * would do: a refusal is said and nothing changes; an op that would move a
 * circuit to another feed waits for "Trotzdem ausführen"; otherwise it
 * applies through the editor's `mutate`, so it autosaves like any edit.
 * Applying reuses the first result when the board is still the one it ran
 * on, and runs the op again when an edit landed in between — never a
 * stale document over a newer one. Pinned circuits get the toast, and the
 * sheet's follow-up (`then`: open the placed module, the new device…) runs
 * last, only for an op that really applied.
 *
 * `onCommitted(before, after)` hears of every op that applied — after its
 * confirmation, with the board it applied on and the board it made — so
 * an action (a finding's "Vorschlag ausführen") can offer the same one-step
 * Rückgängig as a drag (docs/PANEL_ENCLOSURE_R2.md §6.5, `useDropUndo`).
 */
import { useCallback, useLayoutEffect, useRef } from "react";

import { pinnedToast } from "./RegroupConfirm";
import type { AppliedOp, EnclosureOp, RunEnclosureOp } from "./useSheetStack";
import type { CatalogIndex } from "../../../utils/enclosureCatalog";
import type { Regroup } from "../../../utils/enclosureFeeds";
import type { PanelDocument } from "../../../types/schaltplan";

/** What RegroupConfirm needs: the board before and after, the circuits that move, and the go-ahead. */
export interface RegroupRequest {
  before: PanelDocument;
  after: PanelDocument;
  regrouped: Regroup[];
  apply: () => void;
}

export interface EnclosureOpRunnerOptions {
  document: PanelDocument | null;
  index: CatalogIndex | null;
  /** The editor's `mutate`: synchronous, a no-op on a read-only board. */
  mutate: (recipe: (current: PanelDocument) => PanelDocument) => void;
  confirmRegroup: (request: RegroupRequest) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  /** An op applied: the board it ran on and the board it left. */
  onCommitted?: (before: PanelDocument, after: PanelDocument) => void;
}

type Outcome = { applied?: AppliedOp; refusal?: string; before?: PanelDocument };

export function useEnclosureOpRunner(options: EnclosureOpRunnerOptions): RunEnclosureOp {
  // The latest board and callbacks, so the runner keeps its identity across renders.
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });

  return useCallback<RunEnclosureOp>((op: EnclosureOp, then) => {
    const { document: before, index, mutate, confirmRegroup, onError, onNotice, onCommitted } = latest.current;
    if (!before || !index) return;
    const first = op(before, index);
    if (!first.ok) {
      onError(first.error);
      return;
    }
    const apply = () => {
      const outcome: Outcome = {};
      mutate((current) => {
        const result = current === before ? first : op(current, index);
        if (!result.ok) {
          outcome.refusal = result.error;
          return current;
        }
        outcome.applied = result;
        outcome.before = current;
        return result.document;
      });
      if (outcome.refusal) onError(outcome.refusal);
      const applied = outcome.applied;
      if (!applied) return;
      if (outcome.before && outcome.before !== applied.document) onCommitted?.(outcome.before, applied.document);
      if (applied.pinned.length > 0) onNotice(pinnedToast(applied.pinned.length));
      then?.(applied);
    };
    if (first.regrouped.length === 0) {
      apply();
      return;
    }
    confirmRegroup({ before, after: first.document, regrouped: first.regrouped, apply });
  }, []);
}
