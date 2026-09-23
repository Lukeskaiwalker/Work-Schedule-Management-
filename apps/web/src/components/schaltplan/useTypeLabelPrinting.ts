/**
 * The Schrank-Etikett sheet's state and the print call, for SchaltplanPage.
 *
 * Mirrors `useLabelPrinting`: the sheet is opened from the toolbar, printing
 * keeps its own busy flag so it is never mistaken for a save in progress,
 * and a second tap while the label feeds must not print the panel twice.
 * The sheet fetches its own data on open (`PanelTypeLabelDialog`), so there
 * is nothing to seed here — just open, close and print.
 */
import { useCallback, useState } from "react";

import { printPanelTypeLabel, type PanelTypeLabelPrintRequest } from "../../utils/schaltplanApi";
import type { PanelPlan } from "../../types/schaltplan";

type Deps = {
  panel: PanelPlan | null;
  token: string | null;
  setNotice: (message: string) => void;
  setError: (message: string) => void;
};

const PRINT_FAILED = "Schrank-Etikett konnte nicht gedruckt werden";

export function useTypeLabelPrinting({ panel, token, setNotice, setError }: Deps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [printing, setPrinting] = useState(false);

  const open = useCallback(() => setDialogOpen(true), []);
  const close = useCallback(() => setDialogOpen(false), []);

  const print = useCallback(
    async (body: PanelTypeLabelPrintRequest) => {
      if (!panel || printing) return;
      setPrinting(true);
      try {
        const result = await printPanelTypeLabel(token, panel.id, body);
        setNotice(`Schrank-Etikett gedruckt (${result.sheets}×, ${result.material})`);
        close();
      } catch (err) {
        // A 400 carries the server's German sentence (bad Baujahr, wrong
        // stock loaded); 502/503 say the printer is unreachable or missing.
        setError(err instanceof Error && err.message ? err.message : PRINT_FAILED);
      } finally {
        setPrinting(false);
      }
    },
    [panel, printing, token, setNotice, setError, close],
  );

  return { open, close, dialogOpen, printing, print };
}
