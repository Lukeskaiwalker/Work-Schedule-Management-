/**
 * "Schrank wählen" (docs/PANEL_ENCLOSURE.md §3.2, §11): choose, change or
 * remove the board's cabinet.
 *
 * Grouped by height, because the height decides which field kits fit (D5:
 * 1100 mm cabinets take 1050 mm kits, 1400 mm take 1350 mm). Within a group
 * the server's order stands — on the shelf first, then recently used (D4).
 * A change the board cannot take (fewer fields than its modules use, or
 * another height while modules are placed) is said on the item before it
 * is tapped, with the same words the op would refuse with. Removing the
 * cabinet keeps every row and device; it asks first.
 */
import { useMemo, useState } from "react";

import { ConfirmStrip, SheetFrame, SheetSection, UnverifiedBadge } from "./EnclosureSheetFrame";
import { normalizeCode, type CatalogIndex } from "../../../utils/enclosureCatalog";
import { removeEnclosure, setEnclosure } from "../../../utils/enclosureOps";
import type { EditDocument, RunEnclosureOp } from "./useSheetStack";
import type { CatalogEntry, EnclosureCatalog, EnclosureSpec } from "../../../types/panelEnclosure";
import type { PanelDocument } from "../../../types/schaltplan";

const REMOVE_QUESTION = "Schrank aus dem Plan nehmen? Reihen und Geräte bleiben erhalten.";
const MOUNTING_TEXT: Readonly<Record<EnclosureSpec["mounting"], string>> = { surface: "Aufputz" };

type Props = {
  document: PanelDocument;
  catalog: EnclosureCatalog;
  index: CatalogIndex;
  readOnly: boolean;
  onOp: RunEnclosureOp;
  onEdit: EditDocument;
  /** The cabinet was set (or changed) — the tab usually closes the picker. */
  onChosen?: (code: string) => void;
  onBack?: () => void;
  onClose: () => void;
};

type Choice = { entry: CatalogEntry<EnclosureSpec>; spec: EnclosureSpec; current: boolean; refusal: string | null };

/** "{code} · {n} Felder · {H} × {W} × {D} mm · IP44 · Aufputz" (§11). */
export function cabinetLine(spec: EnclosureSpec): string {
  const facts = [
    spec.code,
    `${spec.fields} Felder`,
    `${spec.height_mm} × ${spec.width_mm} × ${spec.depth_mm} mm`,
    spec.ip.trim(),
    MOUNTING_TEXT[spec.mounting] ?? "",
  ];
  return facts.filter(Boolean).join(" · ");
}

/** Pickable cabinets by height: archived and invalid ones hidden, unless the board uses that code. */
function choicesByHeight(document: PanelDocument, catalog: EnclosureCatalog, index: CatalogIndex): [number, Choice[]][] {
  const currentCode = normalizeCode(document.enclosure?.code);
  const groups = new Map<number, Choice[]>();
  for (const entry of catalog.enclosures ?? []) {
    const spec = index.enclosure(entry.code);
    const current = normalizeCode(entry.code) === currentCode;
    if (!spec || (entry.archived && !current)) continue;
    const result = current ? null : setEnclosure(document, index, spec.code);
    const refusal = result && !result.ok ? result.error : null;
    groups.set(spec.height_mm, [...(groups.get(spec.height_mm) ?? []), { entry, spec, current, refusal }]);
  }
  return [...groups.entries()].sort(([a], [b]) => a - b);
}

function CabinetItem({ choice, readOnly, onPick }: { choice: Choice; readOnly: boolean; onPick: (code: string) => void }) {
  const { entry, spec, current, refusal } = choice;
  return (
    <button
      type="button"
      className={["sp-palette-item", "sp-encl-item", current ? "sp-encl-item--current" : ""].filter(Boolean).join(" ")}
      disabled={readOnly || current || refusal !== null}
      aria-current={current ? "true" : undefined}
      onClick={() => onPick(spec.code)}
    >
      <span className="sp-palette-text">
        <b>{cabinetLine(spec)}</b>
        <small>
          {spec.name}
          {entry.stock_available > 0 ? ` · ${entry.stock_available} im Lager` : ""}
          {current ? " · gewählt" : ""}
        </small>
        {refusal ? <small className="sp-encl-item-refusal">{refusal}</small> : null}
      </span>
      {spec.verified ? null : <UnverifiedBadge />}
    </button>
  );
}

export function EnclosurePickerSheet({ document, catalog, index, readOnly, onOp, onEdit, onChosen, onBack, onClose }: Props) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  // Each choice runs the op once to say why it would be refused; only when the board changes.
  const groups = useMemo(() => choicesByHeight(document, catalog, index), [document, catalog, index]);

  const pick = (code: string) => onOp((current, idx) => setEnclosure(current, idx, code), () => onChosen?.(code));
  const remove = () => {
    onEdit(removeEnclosure);
    setConfirmRemove(false);
    onClose();
  };

  return (
    <SheetFrame title="Schrank wählen" subtitle="Hager univers Z · Aufputz" onBack={onBack} onClose={onClose}>
      {groups.length === 0 ? <p className="sp-encl-empty">Der Schrankkatalog ist leer.</p> : null}
      {groups.map(([height, choices]) => (
        <SheetSection key={height} title={`${height} mm hoch`}>
          <div className="sp-palette-grid">
            {choices.map((choice) => (
              <CabinetItem key={choice.spec.code} choice={choice} readOnly={readOnly} onPick={pick} />
            ))}
          </div>
        </SheetSection>
      ))}
      {document.enclosure && !readOnly ? (
        confirmRemove ? (
          <ConfirmStrip
            question={REMOVE_QUESTION}
            confirmLabel="Ja, Schrank entfernen"
            onConfirm={remove}
            onCancel={() => setConfirmRemove(false)}
          />
        ) : (
          <button type="button" className="sp-btn sp-btn--danger sp-encl-target" onClick={() => setConfirmRemove(true)}>
            Schrank entfernen
          </button>
        )
      ) : null}
    </SheetFrame>
  );
}
