/**
 * "Auf andere Hutschiene…" (docs/PANEL_ENCLOSURE.md §10.2, §11; round 2:
 * docs/PANEL_ENCLOSURE_R2.md §6.8): where a device can go inside the
 * cabinet — the legacy SLS into the NAR, a breaker the claim left outside
 * onto a Verteilerfeld rail — and where on that rail.
 *
 * Step 1: every rail is one 56 px line, "Feld {n} · {zone} · {free} PLE
 * frei", grouped by module in the cabinet's reading order. The device's own
 * rail and retired rails are not offered; a rail reserved for terminals is
 * listed but disabled ("für Reihenklemmen reserviert"). A rail too full is
 * still offered (findings warn, they never block, D6) but marked — in words
 * on the item, not in a title a workshop tablet never shows. Fit is the
 * drag's own number (`deviceOverMm`), so the picker and the drop label agree.
 *
 * Step 2, on a rail that holds devices: **Wohin auf {title}?** — Am Anfang,
 * Nach {bmk} for each device, Am Ende. An empty rail needs no step. The
 * pick goes to `onDrop`, which the tab runs as `dropDevice` through the drop
 * note: the device follows its new position (R10) exactly as when dragged,
 * a group head takes its circuits along, and Rückgängig undoes it.
 *
 * ‹, Escape and the backdrop go from step 2 back to step 1 (the stack's
 * back step, `setBackHandler`).
 */
import { useCallback, useEffect, useId, useState } from "react";

import { deviceOverMm } from "./enclosureDropTargets";
import { SheetFrame, SheetSection } from "./EnclosureSheetFrame";
import { formatPle, moduleRails, modulesInOrder, type RailInfo } from "./sheetModel";
import { moduleArticle, type CatalogIndex } from "../../../utils/enclosureCatalog";
import { linkedRows } from "../../../utils/enclosureLayout";
import { dragGroup, reservedRailKey, type DropTarget } from "../../../utils/enclosureOpsDrag";
import { catalogEntry, deviceLabel } from "../../../utils/schaltplanDevices";
import type { PanelDevice, PanelDocument } from "../../../types/schaltplan";

type Props = {
  document: PanelDocument;
  index: CatalogIndex;
  deviceId: string;
  readOnly: boolean;
  /** The chosen rail and place; the tab runs `dropDevice` and shows the note. */
  onDrop: (target: DropTarget) => void;
  /** Terminal rails as `reservedRailKey` (empty until the terminal slice passes them). */
  reserved?: ReadonlySet<string>;
  /** The stack's hook for this sheet's own back step (step 2 → step 1). */
  setBackHandler?: (handler: (() => void) | null) => void;
  onBack?: () => void;
  onClose: () => void;
};

const TIGHT_TEXT = "Zu wenig Platz — die Hutschiene läuft über.";
const RESERVED_TEXT = "für Reihenklemmen reserviert";
const NONE: ReadonlySet<string> = new Set();

type ItemProps = { label: string; note: string | null; disabled: boolean; tight: boolean; onPick: () => void };

/** "Feld {n} · {zone} · {free} PLE frei" (§11) is the name; a full or reserved rail says so under it. */
function RailItem({ label, note, disabled, tight, onPick }: ItemProps) {
  const noteId = useId();
  return (
    <button
      type="button"
      className={["sp-palette-item", "sp-encl-item", tight ? "sp-encl-item--tight" : ""].filter(Boolean).join(" ")}
      disabled={disabled}
      aria-label={label}
      aria-describedby={note ? noteId : undefined}
      onClick={onPick}
    >
      <span className="sp-palette-text">
        <b>{label}</b>
        {note ? (
          <small id={noteId} className="sp-encl-item-refusal">
            {note}
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

/** "Nach F1.2" — a device by its BMK, else its short name; a repeated name gets its place. */
function placeChoices(devices: readonly PanelDevice[]): { label: string; at: number }[] {
  const names = devices.map((device) => device.designation.trim() || catalogEntry(device.kind).short);
  return names.map((name, i) => ({
    label: names.indexOf(name) === names.lastIndexOf(name) ? `Nach ${name}` : `Nach ${name} · Platz ${i + 1}`,
    at: i + 1,
  }));
}

/** Step 2's back step for ‹, Escape and the backdrop, while a rail is chosen. */
function useStepBack(chosen: boolean, back: () => void, setBackHandler: Props["setBackHandler"]) {
  useEffect(() => {
    if (!chosen || !setBackHandler) return undefined;
    setBackHandler(back);
    return () => setBackHandler(null);
  }, [chosen, back, setBackHandler]);
}

type PlaceStepProps = { rail: RailInfo; others: readonly PanelDevice[]; readOnly: boolean; onPick: (at: number) => void; onBack: () => void; onClose: () => void };

function PlaceStep({ rail, others, readOnly, onPick, onBack, onClose }: PlaceStepProps) {
  const choices = [{ label: "Am Anfang", at: 0 }, ...placeChoices(others), { label: "Am Ende", at: others.length }];
  return (
    <SheetFrame title={`Wohin auf ${rail.title}?`} subtitle={`Feld ${rail.field} · ${rail.zoneName}`} onBack={onBack} onClose={onClose}>
      <div className="sp-palette-grid">
        {choices.map((choice) => (
          <button key={choice.label} type="button" className="sp-palette-item sp-encl-item" disabled={readOnly} onClick={() => onPick(choice.at)}>
            <span className="sp-palette-text">
              <b>{choice.label}</b>
            </span>
          </button>
        ))}
      </div>
    </SheetFrame>
  );
}

export function RailPickerSheet({ document, index, deviceId, readOnly, onDrop, reserved = NONE, setBackHandler, onBack, onClose }: Props) {
  const [chosen, setChosen] = useState<{ moduleId: string; railKey: string } | null>(null);
  const backToList = useCallback(() => setChosen(null), []);
  useStepBack(chosen !== null, backToList, setBackHandler);
  const found = locate(document, deviceId);

  if (!found) {
    return (
      <SheetFrame title="Hutschiene wählen" onBack={onBack} onClose={onClose}>
        <p className="sp-encl-empty">Dieses Gerät ist nicht mehr im Plan.</p>
      </SheetFrame>
    );
  }

  const { device, rowId } = found;
  const group = dragGroup(document, index, deviceId);
  const travelling = new Set(group);
  const here = linkedRows(document, index).get(rowId) ?? null;
  const circuits = group.length > 1 ? ` · mit ${group.length - 1 === 1 ? "1 Stromkreis" : `${group.length - 1} Stromkreisen`}` : "";
  const name = [device.designation.trim(), deviceLabel(device.kind, document)].filter(Boolean).join(" · ") + circuits;
  const groups = modulesInOrder(document)
    .map((module) => ({
      module,
      rails: moduleRails(document, index, module, { retired: "never" }).filter(
        (rail) => !(here && here.moduleId === rail.moduleId && here.railKey === rail.railKey),
      ),
    }))
    .filter((entry) => entry.rails.length > 0);

  const picked = chosen ? groups.flatMap((entry) => entry.rails).find((rail) => rail.moduleId === chosen.moduleId && rail.railKey === chosen.railKey) : undefined;
  if (picked) {
    const others = (picked.row?.devices ?? []).filter((candidate) => !travelling.has(candidate.id));
    const drop = (at: number) => onDrop({ moduleId: picked.moduleId, railKey: picked.railKey, at });
    return <PlaceStep rail={picked} others={others} readOnly={readOnly} onPick={drop} onBack={backToList} onClose={onClose} />;
  }

  const pick = (rail: RailInfo) => {
    const others = (rail.row?.devices ?? []).filter((candidate) => !travelling.has(candidate.id));
    // An empty rail has one place only: no second question.
    if (others.length === 0) onDrop({ moduleId: rail.moduleId, railKey: rail.railKey, at: 0 });
    else setChosen({ moduleId: rail.moduleId, railKey: rail.railKey });
  };

  return (
    <SheetFrame title="Hutschiene wählen" subtitle={name} onBack={onBack} onClose={onClose}>
      {groups.length === 0 ? <p className="sp-encl-empty">Im Schrank gibt es keine andere Hutschiene.</p> : null}
      {groups.map(({ module, rails }) => (
        <SheetSection key={module.id} title={`Feld ${module.field + 1} · ${moduleArticle(module, index)}${module.label ? ` · ${module.label}` : ""}`}>
          <div className="sp-palette-grid">
            {rails.map((rail) => {
              const isReserved = reserved.has(reservedRailKey(rail.moduleId, rail.railKey));
              const tight = !isReserved && deviceOverMm(document, index, group, rail.moduleId, rail.railKey) > 0;
              return (
                <RailItem
                  key={rail.railKey}
                  label={`Feld ${rail.field} · ${rail.zoneName} · ${formatPle(rail.freePle)} PLE frei`}
                  note={isReserved ? RESERVED_TEXT : tight ? TIGHT_TEXT : null}
                  tight={tight}
                  disabled={readOnly || isReserved}
                  onPick={() => pick(rail)}
                />
              );
            })}
          </div>
        </SheetSection>
      ))}
    </SheetFrame>
  );
}
