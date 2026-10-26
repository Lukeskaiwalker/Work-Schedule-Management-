/**
 * The label sheet's state and the print call, for SchaltplanPage.
 *
 * Printing goes through a preview sheet: `dialog.ids` is what the sheet
 * opens with — every rail from the toolbar, one from a rail's own button,
 * every terminal strip from the Klemmen tab (`dialog.mode` says which), or
 * the §14a block's wire labels: `open([WIRE_STRIP_ID], "adern")` from the
 * §14a sheet or the Klemmen tab (docs/PANEL_ENCLOSURE_R4.md §9.2).
 * Printing keeps its own busy flag: it must not be mistaken for a save in
 * progress, and a second tap while the strip is feeding would print the
 * board twice.
 *
 * The printer reads the SAVED document — the BMK texts, and for the
 * Reihenklemmen the marker overrides typed into the sheet a moment ago —
 * so `beforePrint` (the page's autosave flush) runs first, and a flush
 * that fails aborts the print rather than feeding stale markers.
 */
import { useCallback, useState } from "react";

import type { LabelPrintMode, LabelPrintOptions } from "./LabelPrintDialog";
import { CONTROL_STRIP_ID } from "../../utils/schaltplanControlStrip";
import { printPanelLabels, type PanelLabelsPrintResult, type PrintPanelLabelsOptions } from "../../utils/schaltplanApi";
import { formatFontMm } from "../../utils/schaltplanStrip";
import type { PanelPlan } from "../../types/schaltplan";

export interface LabelDialogState {
  open: boolean;
  ids: string[];
  mode: LabelPrintMode;
}

const CLOSED: LabelDialogState = { open: false, ids: [], mode: "bmk" };

type Deps = {
  panel: PanelPlan | null;
  token: string | null;
  setNotice: (message: string) => void;
  setError: (message: string) => void;
  /** Settle the autosave before the printer reads the document; false = the save failed, do not print. */
  beforePrint?: () => Promise<boolean>;
};

function stripCountLabel(count: number, terminals: boolean): string {
  if (terminals) return count === 1 ? "1 Klemmen-Etikett" : `${count} Klemmen-Etiketten`;
  return `${count} Streifen`;
}

const FAILED: Readonly<Record<LabelPrintOptions["target"], string>> = {
  bmk: "BMK-Etiketten konnten nicht gedruckt werden",
  reihenklemmen: "Klemmen-Etiketten konnten nicht gedruckt werden",
  adern: "Aderbeschriftung konnte nicht gedruckt werden",
};

/** The request for one target: rails for BMK, strip ids for the Reihenklemmen and the wires. */
function requestFor(ids: string[], materialId: string, target: LabelPrintOptions["target"]): PrintPanelLabelsOptions {
  return target === "bmk" ? { rowIds: ids, materialId, target } : { stripIds: ids, materialId, target };
}

/** The server's one size, when it says something: not for die-cut labels, nor for a print of only the §14a strip (it sizes itself). */
function fontNote(result: PanelLabelsPrintResult, single: boolean): string {
  const sizeDots = result.font_size_dots;
  const strips = result.strips ?? [];
  const onlyControl = strips.length > 0 && strips.every((strip) => strip.row_id === CONTROL_STRIP_ID);
  // Guarded, because an older server does not send it.
  const known = typeof sizeDots === "number" && Number.isFinite(sizeDots) && sizeDots > 0;
  return !single && !onlyControl && known ? ` — Schrift ${formatFontMm(sizeDots)} mm` : "";
}

/** The notice after a print: what went out, the size, what was skipped. */
function printedNotice(result: PanelLabelsPrintResult, materialId: string, target: LabelPrintOptions["target"]): string {
  const terminals = target !== "bmk";
  const skipped =
    result.skipped_without_bmk > 0
      ? terminals
        ? ` — ${result.skipped_without_bmk} Klemme(n) ohne Beschriftung übersprungen`
        : ` — ${result.skipped_without_bmk} Gerät(e) ohne BMK übersprungen`
      : "";
  if (target === "adern") return `${result.printed} Aderetiketten gedruckt${skipped}`;
  const single = !terminals && materialId === "wago-210-805";
  const stripCount = (result.strips ?? []).length;
  const summary = terminals
    ? `${stripCountLabel(stripCount, true)} gedruckt (${result.printed} Klemmen)`
    : single
      ? `${result.printed} Etiketten (210-805) gedruckt`
      : `${stripCountLabel(stripCount, false)} gedruckt (${result.printed} BMK)`;
  // The strip's board size is worth a glance: it tells the electrician
  // whether a long text dragged the whole board down.
  return `${summary}${fontNote(result, single)}${skipped}`;
}

export function useLabelPrinting({ panel, token, setNotice, setError, beforePrint }: Deps) {
  const [dialog, setDialog] = useState<LabelDialogState>(CLOSED);
  const [printing, setPrinting] = useState(false);

  const open = useCallback((ids: string[], mode: LabelPrintMode = "bmk") => {
    setDialog({ open: true, ids, mode });
  }, []);

  const close = useCallback(() => {
    setDialog((current) => ({ ...current, open: false }));
  }, []);

  /** Forget the selection — a sheet left open would list the next board's rails with this board's ticks. */
  const reset = useCallback(() => setDialog(CLOSED), []);

  const print = useCallback(
    async (ids: string[], materialId: string, options: LabelPrintOptions) => {
      if (!panel || printing) return;
      setPrinting(true);
      const target = options.target;
      try {
        if (beforePrint && !(await beforePrint())) {
          setError("Nicht gedruckt: Die Änderungen konnten nicht gespeichert werden — der Drucker würde alte Texte lesen.");
          return;
        }
        const result = await printPanelLabels(token, panel.id, requestFor(ids, materialId, target));
        setNotice(printedNotice(result, materialId, target));
        close();
      } catch (err) {
        setError(err instanceof Error && err.message ? err.message : FAILED[target]);
      } finally {
        setPrinting(false);
      }
    },
    [panel, printing, token, setNotice, setError, close, beforePrint],
  );

  return { dialog, printing, open, close, reset, print };
}
