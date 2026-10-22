/**
 * "Stromkreise ändern ihre Einspeisung" (docs/PANEL_ENCLOSURE.md D4, §2.4,
 * §11): no cabinet op may move a breaker from FI F1 to a Hauptschalter
 * without anyone noticing. `preserveFeeds` pins every circuit it can; the
 * ones it cannot — their old head is gone, or they hung straight off the
 * Einspeisung — come here, one line each, before the op applies. The op
 * runs only on "Trotzdem ausführen"; ×, Escape and the backdrop cancel.
 */
import { SheetFrame } from "./EnclosureSheetFrame";
import { deviceLabel, catalogEntry } from "../../../utils/schaltplanDevices";
import type { Regroup } from "../../../utils/enclosureFeeds";
import type { PanelDevice, PanelDocument } from "../../../types/schaltplan";

/** "{n} Stromkreis(e) behalten ihre Einspeisung — fest eingetragen." — the toast for `pinned`. */
export function pinnedToast(count: number): string {
  return `${count} Stromkreis(e) behalten ihre Einspeisung — fest eingetragen.`;
}

function findIn(documents: readonly PanelDocument[], id: string): { device: PanelDevice; document: PanelDocument } | null {
  for (const document of documents) {
    for (const row of document.rows) {
      const device = row.devices.find((candidate) => candidate.id === id);
      if (device) return { device, document };
    }
  }
  return null;
}

/** A circuit by its BMK, else its consumer text, else its kind. */
function circuitName(documents: readonly PanelDocument[], id: string): string {
  const found = findIn(documents, id);
  if (!found) return id;
  const { device, document } = found;
  return device.designation.trim() || device.label.trim() || deviceLabel(device.kind, document);
}

/** A group head by its BMK, else its short name ("FI"); "" is the Einspeisung. */
function headName(documents: readonly PanelDocument[], id: string): string {
  if (id === "") return "Einspeisung";
  const found = findIn(documents, id);
  if (!found) return id;
  return found.device.designation.trim() || catalogEntry(found.device.kind).short;
}

/** "{bmk}: {from} → {to}" per circuit. Names come from the board after the op first, then before it. */
export function regroupLines(regrouped: readonly Regroup[], before: PanelDocument, after: PanelDocument): string[] {
  const documents = [after, before];
  return regrouped.map(
    (entry) => `${circuitName(documents, entry.deviceId)}: ${headName(documents, entry.from)} → ${headName(documents, entry.to)}`,
  );
}

type Props = {
  regrouped: readonly Regroup[];
  before: PanelDocument;
  after: PanelDocument;
  onConfirm: () => void;
  onCancel: () => void;
};

export function RegroupConfirm({ regrouped, before, after, onConfirm, onCancel }: Props) {
  const lines = regroupLines(regrouped, before, after);
  return (
    <SheetFrame
      title="Stromkreise ändern ihre Einspeisung"
      subtitle="Diese Stromkreise hängen danach an einer anderen Einspeisung."
      role="alertdialog"
      onClose={onCancel}
      className="sp-encl-regroup"
      footer={
        <>
          <button type="button" className="sp-btn sp-btn--armed sp-encl-target" onClick={onConfirm}>
            Trotzdem ausführen
          </button>
          <button type="button" className="sp-btn sp-encl-target" onClick={onCancel}>
            Abbrechen
          </button>
        </>
      }
    >
      <ul className="sp-encl-regroup-list">
        {lines.map((line, position) => (
          <li key={`${regrouped[position].deviceId}-${position}`}>{line}</li>
        ))}
      </ul>
    </SheetFrame>
  );
}
