/**
 * The label sheet's state and the print call, for SchaltplanPage.
 *
 * Printing goes through a preview sheet: `dialog.ids` is what the sheet
 * opens with — every rail from the toolbar, one from a rail's own button,
 * every FI group from the Klemmen tab (`dialog.mode` says which). Printing
 * keeps its own busy flag: it must not be mistaken for a save in progress,
 * and a second tap while the strip is feeding would print the board twice.
 */
import { useCallback, useState } from "react";

import type { LabelPrintMode, LabelPrintOptions } from "./LabelPrintDialog";
import { printPanelLabels } from "../../utils/schaltplanApi";
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
};

export function useLabelPrinting({ panel, token, setNotice, setError }: Deps) {
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
      const terminals = options.target === "reihenklemmen";
      try {
        const result = await printPanelLabels(
          token,
          panel.id,
          terminals
            ? { groupIds: ids, materialId, target: "reihenklemmen", terminalText: options.terminalText }
            : { rowIds: ids, materialId, target: "bmk" },
        );
        const skipped =
          result.skipped_without_bmk > 0
            ? terminals
              ? ` — ${result.skipped_without_bmk} Klemme(n) ohne Beschriftung übersprungen`
              : ` — ${result.skipped_without_bmk} Gerät(e) ohne BMK übersprungen`
            : "";
        const single = !terminals && materialId === "wago-210-805";
        const stripCount = (result.strips ?? []).length;
        const summary = terminals
          ? `${stripCount} Klemmen-Streifen gedruckt (${result.printed} Klemmen)`
          : single
            ? `${result.printed} Etiketten (210-805) gedruckt`
            : `${stripCount} Streifen gedruckt (${result.printed} BMK)`;
        // The strip's board size is worth a glance: it tells the electrician
        // whether a long text dragged the whole board down. Guarded, because
        // an older server does not send it.
        const sizeDots = result.font_size_dots;
        const font =
          !single && typeof sizeDots === "number" && Number.isFinite(sizeDots) && sizeDots > 0
            ? ` — Schrift ${formatFontMm(sizeDots)} mm`
            : "";
        setNotice(`${summary}${font}${skipped}`);
        close();
      } catch (err) {
        setError(
          err instanceof Error && err.message
            ? err.message
            : terminals
              ? "Klemmen-Etiketten konnten nicht gedruckt werden"
              : "BMK-Etiketten konnten nicht gedruckt werden",
        );
      } finally {
        setPrinting(false);
      }
    },
    [panel, printing, token, setNotice, setError, close],
  );

  return { dialog, printing, open, close, reset, print };
}
