/**
 * The Schrank tab's terminal actions (docs/PANEL_ENCLOSURE_R2.md §4.2,
 * §6.5, §7.2, §7.4): strip moves, the order reset, and every finding's
 * suggestion — all with the drop note's one-step Rückgängig.
 *
 * - Strip moves and the reset are plain edits: `useDropUndo.run`, one
 *   `mutate`, the note ("X3 verschoben: Feld 2 · Hutschiene 1.").
 * - The suggestions move rows or circuits, so they go through an op runner
 *   of their own — C§2.4 pins, RegroupConfirm when a feed would change —
 *   whose `onCommitted` hands the board before and after to
 *   `useDropUndo.remember`. A separate runner, because the tab's main one
 *   also runs every sheet op, which must not raise the drop note.
 * - `actions` keys each suggestion by `${rule}|${scope}` (a vacate and the
 *   placeholders by each of their rows), for the findings list, the
 *   close-up and RailSheet: "Vorschlag ausführen", "Reihenfolge
 *   zurücksetzen", "Platzhalter entfernen".
 */
import { useCallback, useMemo, useRef } from "react";

import { describeAction, describeStripMove } from "./dropNoteText";
import { findingKey, type FindingAction } from "./EnclosureFindings";
import type { DropUndo } from "./useDropUndo";
import { useEnclosureOpRunner, type RegroupRequest } from "./useEnclosureOpRunner";
import type { EnclosureOp } from "./useSheetStack";
import type { CatalogIndex } from "../../../utils/enclosureCatalog";
import type { OpResult } from "../../../utils/enclosureOps";
import {
  moveGroupToRails,
  moveTerminalStrip,
  relinkRows,
  removeTerminalPlaceholders,
  resetTerminalOrder,
  type StripTarget,
} from "../../../utils/enclosureOpsTerminals";
import type { TerminalSuggestion } from "../../../types/panelEnclosure";
import type { PanelDocument } from "../../../types/schaltplan";

export interface TerminalActionsArgs {
  document: PanelDocument | null;
  index: CatalogIndex | null;
  suggestions: readonly TerminalSuggestion[];
  readOnly: boolean;
  drops: DropUndo;
  mutate: (recipe: (current: PanelDocument) => PanelDocument) => void;
  confirmRegroup: (request: RegroupRequest) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}

export interface TerminalActions {
  /** By `${rule}|${scope}`; empty on a read-only board. */
  actions: ReadonlyMap<string, FindingAction>;
  runSuggestion: (suggestion: TerminalSuggestion) => void;
  moveStrip: (stripId: string, target: StripTarget) => void;
  resetOrder: (field: number) => void;
}

const applied = (document: PanelDocument): OpResult => ({ ok: true, document, pinned: [], regrouped: [] });

/** The op a suggestion stands for. */
function opFor(suggestion: TerminalSuggestion): EnclosureOp {
  switch (suggestion.kind) {
    case "relink_rows":
      return (current, index) => relinkRows(current, index, suggestion.moves);
    case "move_group":
      return (current, index) => moveGroupToRails(current, index, suggestion.deviceIds, suggestion.targets);
    case "reset_order":
      return (current, index) => applied(resetTerminalOrder(current, index, suggestion.field));
    case "remove_placeholders":
      return (current, index) => applied(removeTerminalPlaceholders(current, index, suggestion.deviceIds));
  }
}

const LABELS: Readonly<Record<TerminalSuggestion["kind"], string>> = {
  relink_rows: "Vorschlag ausführen",
  move_group: "Vorschlag ausführen",
  reset_order: "Reihenfolge zurücksetzen",
  remove_placeholders: "Platzhalter entfernen",
};

function scopesOf(suggestion: TerminalSuggestion): readonly string[] {
  return suggestion.kind === "relink_rows" || suggestion.kind === "remove_placeholders" ? suggestion.scopes : [suggestion.scope];
}

export function useTerminalActions(args: TerminalActionsArgs): TerminalActions {
  const { document, index, suggestions, readOnly, drops, mutate, confirmRegroup, onError, onNotice } = args;
  const pending = useRef<TerminalSuggestion | null>(null);
  const { remember, run: runDrop } = drops;
  const runAction = useEnclosureOpRunner({
    document,
    index,
    mutate,
    confirmRegroup,
    onError,
    onNotice,
    onCommitted: (before, after) => {
      const suggestion = pending.current;
      if (suggestion && index) remember(before, after, describeAction(before, after, index, suggestion));
    },
  });
  const runSuggestion = useCallback(
    (suggestion: TerminalSuggestion) => {
      pending.current = suggestion;
      runAction(opFor(suggestion));
    },
    [runAction],
  );
  const moveStrip = useCallback(
    (stripId: string, target: StripTarget) => {
      if (!index) return;
      runDrop(
        (current) => moveTerminalStrip(current, index, stripId, target),
        (before, after) => describeStripMove(before, after, index, stripId),
      );
    },
    [index, runDrop],
  );
  const resetOrder = useCallback(
    (field: number) => {
      if (!index) return;
      const reset: TerminalSuggestion = { rule: "encl.terminal_order_ignored", field, kind: "reset_order", scope: "" };
      runDrop(
        (current) => applied(resetTerminalOrder(current, index, field)),
        (before, after) => describeAction(before, after, index, reset),
      );
    },
    [index, runDrop],
  );
  const actions = useMemo(() => {
    const map = new Map<string, FindingAction>();
    if (readOnly) return map;
    for (const suggestion of suggestions) {
      const action: FindingAction = { label: LABELS[suggestion.kind], run: () => runSuggestion(suggestion) };
      for (const scope of scopesOf(suggestion)) map.set(findingKey(suggestion.rule, scope), action);
    }
    return map;
  }, [suggestions, readOnly, runSuggestion]);
  return { actions, runSuggestion, moveStrip, resetOrder };
}
