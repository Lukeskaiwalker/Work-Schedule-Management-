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
 *
 * On a board with a cabinet (docs/PANEL_ENCLOSURE.md D7, D13) a fifth
 * section offers the parts that only exist there (the HLAK of a meter
 * field), and a DIN rail meter is called "Zwischenzähler (Hutschiene)": the
 * eHZ itself goes onto the cabinet's meter place. Inside the Schrank tab's
 * sheet stack the palette has no backdrop of its own (`embedded`), and its
 * × takes the stack's 56 px glove size (`sp-sheet--glove`).
 */
import { DeviceSymbol } from "./DeviceSymbol";
import { DEVICE_CATALOG, PALETTE_SECTIONS, deviceLabel, type DeviceCatalogEntry } from "../../utils/schaltplanDevices";
import type { DeviceKind, PanelDocument } from "../../types/schaltplan";

type Props = {
  open: boolean;
  targetRowLabel: string;
  onPick: (kind: DeviceKind) => void;
  onClose: () => void;
  /** The board: its cabinet decides which kinds are offered and how a meter is named. */
  document?: Pick<PanelDocument, "enclosure"> | null;
  /** Inside a sheet stack that renders the one backdrop itself. */
  embedded?: boolean;
};

const ENTRIES = Object.values(DEVICE_CATALOG);

/** Parts that belong to a cabinet module, offered only on a board that has one. */
const CABINET_SECTION: { key: DeviceCatalogEntry["section"]; label: string } = { key: "schrank", label: "Schrank" };

export function DevicePalette({ open, targetRowLabel, onPick, onClose, document = null, embedded = false }: Props) {
  if (!open) return null;

  const sections = document?.enclosure ? [...PALETTE_SECTIONS, CABINET_SECTION] : PALETTE_SECTIONS;
  const bySection = (section: DeviceCatalogEntry["section"]) =>
    ENTRIES.filter((entry) => entry.section === section);

  return (
    <>
      {embedded ? null : <div className="sp-sheet-backdrop" onClick={onClose} aria-hidden="true" />}
      <div className={embedded ? "sp-sheet sp-sheet--glove" : "sp-sheet"} role="dialog" aria-modal="true" aria-label="Gerät hinzufügen">
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
          {sections.map((section) => (
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
                      <b>{deviceLabel(entry.kind, document)}</b>
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
