/**
 * The "add a device" sheet.
 *
 * A bottom sheet rather than a dropdown or a sidebar: on a phone held in one
 * hand the bottom third of the screen is the only comfortably reachable
 * area, and the same component reads as a normal panel on a tablet. Targets
 * are 56 px tall — the size a gloved thumb hits reliably.
 *
 * Sectioned by role (Schutz / Abgänge / Funktion / Sonstiges) because a flat
 * list of 19 kinds is a wall; the two sections an electrician needs 90 % of
 * the time sit at the top.
 */
import { DeviceSymbol } from "./DeviceSymbol";
import { DEVICE_CATALOG, PALETTE_SECTIONS, type DeviceCatalogEntry } from "../../utils/schaltplanDevices";
import type { DeviceKind } from "../../types/schaltplan";

type Props = {
  open: boolean;
  targetRowLabel: string;
  onPick: (kind: DeviceKind) => void;
  onClose: () => void;
};

const ENTRIES = Object.values(DEVICE_CATALOG);

export function DevicePalette({ open, targetRowLabel, onPick, onClose }: Props) {
  if (!open) return null;

  const bySection = (section: DeviceCatalogEntry["section"]) =>
    ENTRIES.filter((entry) => entry.section === section);

  return (
    <>
      <div className="sp-sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="sp-sheet" role="dialog" aria-modal="true" aria-label="Gerät hinzufügen">
        <div className="sp-sheet-head">
          <div>
            <h3>Gerät hinzufügen</h3>
            <small>{targetRowLabel}</small>
          </div>
          <button type="button" className="sp-sheet-close" onClick={onClose} aria-label="Schließen">
            ×
          </button>
        </div>

        <div className="sp-sheet-body">
          {PALETTE_SECTIONS.map((section) => (
            <section key={section.key} className="sp-palette-section">
              <h4>{section.label}</h4>
              <div className="sp-palette-grid">
                {bySection(section.key).map((entry) => (
                  <button
                    key={entry.kind}
                    type="button"
                    className="sp-palette-item"
                    onClick={() => onPick(entry.kind)}
                  >
                    <span className="sp-palette-icon">
                      <DeviceSymbol kind={entry.kind} size={26} />
                    </span>
                    <span className="sp-palette-text">
                      <b>{entry.label}</b>
                      <small>
                        {entry.te} TE
                        {entry.group ? " · öffnet Gruppe" : ""}
                        {entry.circuit ? " · Stromkreis" : ""}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}
