/**
 * "Vorschlag ausführen" on the Aufbau tab (docs/PANEL_ENCLOSURE_R2.md §4.2,
 * §6.5, §9, slice W4b).
 *
 * A row on a reserved terminal rail shows its `encl.terminal_rail_devices`
 * finding, and the suggestion behind it runs from there exactly as from the
 * Schrank tab's findings: `useTerminalActions` keys each suggestion by
 * `${rule}|${scope}`, its op runner pins (toast) or waits for RegroupConfirm,
 * and `useDropUndo.remember` puts the drop note with its one-step
 * **Rückgängig** on screen. The Aufbau tab has no sheet stack, so the
 * confirm comes with its own backdrop (as `useAufbauRailAdd`'s does).
 *
 * The suggestions read the page's one `useBoardTerminals` answer (§6.7);
 * nothing is offered before it is ready, nor on a read-only board.
 * `overlay` is the note and the confirm: the page renders it while the
 * Aufbau tab is shown, so the Schrank tab's own note never doubles it.
 */
import { useMemo, useState, type ReactElement } from "react";

import { DropNote } from "./DropNote";
import type { FindingAction } from "./EnclosureFindings";
import { SheetBackdrop } from "./EnclosureSheetFrame";
import { RegroupConfirm } from "./RegroupConfirm";
import { useDropUndo } from "./useDropUndo";
import type { RegroupRequest } from "./useEnclosureOpRunner";
import { useTerminalActions } from "./useTerminalActions";
import type { BoardTerminalsState } from "../../../hooks/useBoardTerminals";
import type { CatalogIndex } from "../../../utils/enclosureCatalog";
import { terminalSuggestions } from "../../../utils/enclosureTerminalSuggest";
import type { TerminalSuggestion } from "../../../types/panelEnclosure";
import type { PanelDocument } from "../../../types/schaltplan";

export interface AufbauTerminalActionsOptions {
  document: PanelDocument | null;
  index: CatalogIndex | null;
  /** The page's one derivation of the board's terminals. */
  boardTerminals: BoardTerminalsState;
  readOnly: boolean;
  /** The editor's `mutate`: synchronous, a no-op on a read-only board. */
  mutate: (recipe: (current: PanelDocument) => PanelDocument) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}

export interface AufbauTerminalActions {
  /** By `${rule}|${scope}`, for RailEditor's `findingActions`; empty while nothing may run. */
  actions: ReadonlyMap<string, FindingAction>;
  /** The drop note (Rückgängig) and, while a feed change waits, RegroupConfirm behind its backdrop. */
  overlay: ReactElement;
}

const NO_SUGGESTIONS: readonly TerminalSuggestion[] = Object.freeze([]);

export function useAufbauTerminalActions(options: AufbauTerminalActionsOptions): AufbauTerminalActions {
  const { document, index, boardTerminals, readOnly, mutate, onError, onNotice } = options;
  const [pending, setPending] = useState<RegroupRequest | null>(null);
  const { terms, placement } = boardTerminals;
  const suggestions = useMemo(
    () =>
      !readOnly && document?.enclosure && index && terms && placement
        ? terminalSuggestions(document, index, terms, placement)
        : NO_SUGGESTIONS,
    [readOnly, document, index, terms, placement],
  );
  const drops = useDropUndo({ document, mutate });
  const { actions } = useTerminalActions({
    document,
    index,
    suggestions,
    readOnly,
    drops,
    mutate,
    confirmRegroup: setPending,
    onError,
    onNotice,
  });

  const cancel = () => setPending(null);
  const overlay = (
    <>
      {pending ? (
        <>
          <SheetBackdrop onDismiss={cancel} />
          <RegroupConfirm
            regrouped={pending.regrouped}
            before={pending.before}
            after={pending.after}
            onConfirm={() => {
              setPending(null);
              pending.apply();
            }}
            onCancel={cancel}
          />
        </>
      ) : null}
      <DropNote note={drops.note} onUndo={drops.undo} onDismiss={drops.dismiss} />
    </>
  );
  return { actions, overlay };
}
