/**
 * What the Schaltplan page wires for the §14a block and the cabinet
 * preparation outside the Schrank tab (docs/PANEL_ENCLOSURE_R4.md §8.5,
 * §9.1, §9.2), kept out of the page, which is an orchestrator:
 *
 * - `printKlemmen`: the Klemmen print opens with every strip ticked, the
 *   §14a strip last (`klemmenStripIds`; a strip with a label too long to
 *   print is left out);
 * - `printWires`: the label dialog in mode `adern`, only while the board has
 *   a block that is not removed (the Klemmen tab's button, the §14a sheet);
 * - `infeedHint`: the Daten tab's "Querschnitt erkannt: …", derived only
 *   while the tab is shown (`wantHint`) and the catalogue is there.
 */
import { useCallback, useMemo } from "react";

import { infeedHint } from "./enclosure/prepListModel";
import type { LabelPrintMode } from "./LabelPrintDialog";
import type { CatalogIndex } from "../../utils/enclosureCatalog";
import { storedBlock } from "../../utils/enclosureControlBlock";
import { cabinetPrep } from "../../utils/enclosurePrep";
import { WIRE_STRIP_ID, controlStrip, klemmenStripIds } from "../../utils/schaltplanControlStrip";
import type { PanelDocument } from "../../types/schaltplan";

interface Args {
  document: PanelDocument | null;
  index: CatalogIndex | null;
  /** The board's terminal groups (`useBoardTerminals`), in board order. */
  groups: readonly { strips: readonly { stripId: string }[] }[];
  /** The Daten tab is shown: derive its hint. */
  wantHint: boolean;
  /** The page's `useLabelPrinting().open`. */
  openLabels: (ids: string[], mode: LabelPrintMode) => void;
}

export function usePanelControlBlock({ document, index, groups, wantHint, openLabels }: Args) {
  const control = useMemo(() => (document ? controlStrip(document) : null), [document]);
  const block = useMemo(() => (document ? storedBlock(document) : null), [document]);
  const hint = useMemo(
    () => (wantHint && document?.enclosure && index ? infeedHint(cabinetPrep(document, index), document.supply.fuse) : null),
    [wantHint, document, index],
  );
  const printKlemmen = useCallback(() => openLabels(klemmenStripIds(groups, control), "reihenklemmen"), [openLabels, groups, control]);
  const printWires = useMemo(
    () => (block && !block.off ? () => openLabels([WIRE_STRIP_ID], "adern") : undefined),
    [block, openLabels],
  );
  return { infeedHint: hint, printKlemmen, printWires, hasControlStrip: control !== null && control.tooLong === null };
}
