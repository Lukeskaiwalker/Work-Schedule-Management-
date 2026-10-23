/**
 * The page's device palette: what it adds to, and how (docs/PANEL_ENCLOSURE_R2.md
 * §9; extracted from SchaltplanPage per §11 so the page stays under the cap).
 *
 * The target is a row ("+ Gerät" on an existing row: a plain edit) or an
 * empty cabinet rail of the Aufbau tab (the cabinet op `addDeviceToRail`
 * through `useAufbauRailAdd`, with pinning and RegroupConfirm). Either way
 * the palette closes on the pick and the new device's inspector opens —
 * adding a device is never the whole intent, the next thing is always
 * naming what it feeds.
 */
import { useCallback, useState } from "react";

import { useAufbauRailAdd, type AufbauRailTarget } from "./enclosure/useAufbauRailAdd";
import type { PanelDocumentEditor } from "../../hooks/usePanelDocumentEditor";
import type { CatalogIndex } from "../../utils/enclosureCatalog";
import type { DeviceKind, PanelDocument } from "../../types/schaltplan";

export type PaletteTarget = { rowId: string } | AufbauRailTarget;

type Deps = {
  document: PanelDocument | null;
  index: CatalogIndex | null;
  editor: Pick<PanelDocumentEditor, "addDevice" | "mutate">;
  /** The new device: the page selects it, which opens its inspector. */
  onAdded: (deviceId: string) => void;
  setNotice: (message: string) => void;
  setError: (message: string) => void;
};

export function useSchaltplanPalette({ document, index, editor, onAdded, setNotice, setError }: Deps) {
  const [target, setTarget] = useState<PaletteTarget | null>(null);
  const railAdd = useAufbauRailAdd({ document, index, mutate: editor.mutate, onError: setError, onNotice: setNotice, onAdded });

  const openRow = useCallback((rowId: string) => setTarget({ rowId }), []);
  const openRail = useCallback((rail: AufbauRailTarget) => setTarget(rail), []);
  const close = useCallback(() => setTarget(null), []);

  const pick = (kind: DeviceKind) => {
    if (!target) return;
    setTarget(null);
    if ("rowId" in target) {
      const deviceId = editor.addDevice(target.rowId, kind);
      if (deviceId) onAdded(deviceId);
      return;
    }
    railAdd.add(target, kind);
  };

  const label =
    target && !("rowId" in target)
      ? target.label
      : (document?.rows.find((row) => row.id === target?.rowId)?.label ?? "Reihe");

  return {
    openRow,
    openRail,
    /** DevicePalette's props, the board aside. */
    sheet: { open: target !== null, targetRowLabel: label, onPick: pick, onClose: close },
    /** RegroupConfirm for a rail add that would move a circuit's feed, else null. */
    confirm: railAdd.confirm,
  };
}
