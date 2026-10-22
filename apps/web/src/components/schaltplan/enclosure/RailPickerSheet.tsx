/**
 * "Auf andere Hutschiene…" (docs/PANEL_ENCLOSURE.md §10.2, §11): where a
 * device can go inside the cabinet — the legacy SLS into the NAR, a breaker
 * the claim left outside onto a Verteilerfeld rail.
 *
 * Every rail is one 56 px line, "Feld {n} · {zone} · {free} PLE frei",
 * grouped by module in the cabinet's reading order. The device's own rail
 * and retired rails are not offered. A rail too full for the device is
 * still offered (findings warn, they never block, D6) but marked — in words
 * on the item, not in a title a workshop tablet never shows. The move keeps
 * a pre-fitted part pre-fitted and keeps every feed (`preserveFeeds`).
 */
import { useId } from "react";

import { SheetFrame, SheetSection } from "./EnclosureSheetFrame";
import { formatPle, moduleRails, modulesInOrder } from "./sheetModel";
import { moduleArticle, type CatalogIndex } from "../../../utils/enclosureCatalog";
import { enclosureDeviceWidthMm, linkedRows } from "../../../utils/enclosureLayout";
import { moveDeviceToRail } from "../../../utils/enclosureOps";
import { deviceLabel } from "../../../utils/schaltplanDevices";
import { MODULE_WIDTH_MM } from "../../../utils/schaltplanStrip";
import type { RunEnclosureOp } from "./useSheetStack";
import type { PanelDevice, PanelDocument } from "../../../types/schaltplan";

type Props = {
  document: PanelDocument;
  index: CatalogIndex;
  deviceId: string;
  readOnly: boolean;
  onOp: RunEnclosureOp;
  /** The device moved — the tab usually returns to the inspector or opens the target rail. */
  onMoved?: (target: { moduleId: string; railKey: string }) => void;
  onBack?: () => void;
  onClose: () => void;
};

const TIGHT_TEXT = "Zu wenig Platz — die Hutschiene läuft über.";

type ItemProps = { label: string; tight: boolean; readOnly: boolean; onPick: () => void };

/** "Feld {n} · {zone} · {free} PLE frei" (§11) is the name; a rail too full says so under it. */
function RailItem({ label, tight, readOnly, onPick }: ItemProps) {
  const noteId = useId();
  return (
    <button
      type="button"
      className={["sp-palette-item", "sp-encl-item", tight ? "sp-encl-item--tight" : ""].filter(Boolean).join(" ")}
      disabled={readOnly}
      aria-label={label}
      aria-describedby={tight ? noteId : undefined}
      onClick={onPick}
    >
      <span className="sp-palette-text">
        <b>{label}</b>
        {tight ? (
          <small id={noteId} className="sp-encl-item-refusal">
            {TIGHT_TEXT}
          </small>
        ) : null}
      </span>
    </button>
  );
}

function locate(document: PanelDocument, deviceId: string): { device: PanelDevice; rowId: string } | null {
  for (const row of document.rows) {
    const device = row.devices.find((candidate) => candidate.id === deviceId);
    if (device) return { device, rowId: row.id };
  }
  return null;
}

export function RailPickerSheet({ document, index, deviceId, readOnly, onOp, onMoved, onBack, onClose }: Props) {
  const found = locate(document, deviceId);

  if (!found) {
    return (
      <SheetFrame title="Hutschiene wählen" onBack={onBack} onClose={onClose}>
        <p className="sp-encl-empty">Dieses Gerät ist nicht mehr im Plan.</p>
      </SheetFrame>
    );
  }

  const { device, rowId } = found;
  const here = linkedRows(document, index).get(rowId) ?? null;
  const name = [device.designation.trim(), deviceLabel(device.kind, document)].filter(Boolean).join(" · ");
  const groups = modulesInOrder(document)
    .map((module) => ({
      module,
      rails: moduleRails(document, index, module, { retired: "never" }).filter(
        (rail) => !(here && here.moduleId === rail.moduleId && here.railKey === rail.railKey),
      ),
    }))
    .filter((group) => group.rails.length > 0);
  const move = (moduleId: string, railKey: string) =>
    onOp((current, idx) => moveDeviceToRail(current, idx, deviceId, moduleId, railKey), () => onMoved?.({ moduleId, railKey }));

  return (
    <SheetFrame title="Hutschiene wählen" subtitle={name} onBack={onBack} onClose={onClose}>
      {groups.length === 0 ? <p className="sp-encl-empty">Im Schrank gibt es keine andere Hutschiene.</p> : null}
      {groups.map(({ module, rails }) => (
        <SheetSection key={module.id} title={`Feld ${module.field + 1} · ${moduleArticle(module, index)}${module.label ? ` · ${module.label}` : ""}`}>
          <div className="sp-palette-grid">
            {rails.map((rail) => {
              const needs = enclosureDeviceWidthMm(device, rail.rail) / MODULE_WIDTH_MM;
              return (
                <RailItem
                  key={rail.railKey}
                  label={`Feld ${rail.field} · ${rail.zoneName} · ${formatPle(rail.freePle)} PLE frei`}
                  tight={rail.freePle + 0.05 < needs}
                  readOnly={readOnly}
                  onPick={() => move(rail.moduleId, rail.railKey)}
                />
              );
            })}
          </div>
        </SheetSection>
      ))}
    </SheetFrame>
  );
}
