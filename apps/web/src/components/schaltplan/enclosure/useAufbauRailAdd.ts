/**
 * "+ Gerät" on an empty cabinet rail of the Aufbau tab
 * (docs/PANEL_ENCLOSURE_R2.md §9, R14).
 *
 * The Aufbau tab has no sheet stack, so it gets the Schrank tab's op runner
 * on its own: `addDeviceToRail` creates and links the rail's row, keeps the
 * SLS → HS link, and goes through the same C§2.4 tail — a refusal is said,
 * pinned circuits get the toast, and a circuit that would move to another
 * feed waits for RegroupConfirm (behind one SheetBackdrop) before anything
 * changes. `onAdded` follows only once the device is really on the board,
 * so the page can open its inspector.
 */
import { createElement, Fragment, useCallback, useState, type ReactElement } from "react";

import { SheetBackdrop } from "./EnclosureSheetFrame";
import { RegroupConfirm } from "./RegroupConfirm";
import { useEnclosureOpRunner, type RegroupRequest } from "./useEnclosureOpRunner";
import { addDeviceToRail } from "../../../utils/enclosureOps";
import type { CatalogIndex } from "../../../utils/enclosureCatalog";
import type { DeviceKind, PanelDocument } from "../../../types/schaltplan";

/** The rail an empty Aufbau line stands for; `label` is what the new row will be called. */
export interface AufbauRailTarget {
  moduleId: string;
  railKey: string;
  label: string;
}

export interface AufbauRailAddOptions {
  document: PanelDocument | null;
  index: CatalogIndex | null;
  /** The editor's `mutate`: a no-op on a read-only board. */
  mutate: (recipe: (current: PanelDocument) => PanelDocument) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  /** The new device is on the board (after the confirm, if one was needed). */
  onAdded: (deviceId: string) => void;
}

export interface AufbauRailAdd {
  add(target: AufbauRailTarget, kind: DeviceKind): void;
  /** RegroupConfirm with its backdrop while a confirm is open, else null. */
  confirm: ReactElement | null;
}

export function useAufbauRailAdd({ document, index, mutate, onError, onNotice, onAdded }: AufbauRailAddOptions): AufbauRailAdd {
  const [pending, setPending] = useState<RegroupRequest | null>(null);
  const runOp = useEnclosureOpRunner({ document, index, mutate, confirmRegroup: setPending, onError, onNotice });

  const add = useCallback(
    (target: AufbauRailTarget, kind: DeviceKind) =>
      runOp(
        (current, catalogue) => addDeviceToRail(current, catalogue, target.moduleId, target.railKey, kind),
        (result) => {
          if (result.deviceId) onAdded(result.deviceId);
        },
      ),
    [runOp, onAdded],
  );

  const cancel = () => setPending(null);
  const confirm = pending
    ? createElement(
        Fragment,
        null,
        createElement(SheetBackdrop, { onDismiss: cancel }),
        createElement(RegroupConfirm, {
          regrouped: pending.regrouped,
          before: pending.before,
          after: pending.after,
          onConfirm: () => {
            setPending(null);
            pending.apply();
          },
          onCancel: cancel,
        }),
      )
    : null;

  return { add, confirm };
}
