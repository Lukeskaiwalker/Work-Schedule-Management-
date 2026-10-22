/**
 * The physical view: rails (Reihen) and what sits on them, left to right.
 *
 * This is the view the board is actually *built* in, and the one that works
 * on a phone — the diagram is for reading, this is for entering. Device order
 * here is not cosmetic: it is what decides which FI protects which circuit
 * (see `utils/schaltplanTopology.ts`), which is why the reorder controls are
 * arrow buttons rather than drag-and-drop. Dragging a 1 TE breaker between
 * two others with a gloved thumb on a moving ladder does not work; two taps
 * do, and they are undoable.
 *
 * Each device tile is sized by its TE width so the row reads like the real
 * rail — a 4 TE FI is visibly four times an LS — with a slot meter showing
 * how full the rail is.
 *
 * On a board with a cabinet (docs/PANEL_ENCLOSURE.md §11) the rows are
 * grouped by the module whose rail they sit on ("Feld {n} · {art} {name}",
 * rails top to bottom), and rows on no rail of the cabinet come last under
 * "Nicht im Schrank". A row on a cabinet rail IS that rail: its width is
 * the rail's PLE and the module owns it, so its slots are shown but not
 * edited and it cannot be removed here (removing the module or emptying
 * the rail does that). Devices on it are edited as everywhere else.
 */
import { DeviceSymbol } from "./DeviceSymbol";
import { railEditorGroups } from "./enclosure/enclosureEditorModel";
import type { CatalogIndex } from "../../utils/enclosureCatalog";
import { catalogEntry, deviceLabel, rowUsedSlots } from "../../utils/schaltplanDevices";
import { hasTerminal } from "../../utils/schaltplanTerminalRules";
import { isCircuitDevice, isGroupDevice } from "../../utils/schaltplanTopology";
import type { PanelDocument, PanelRow } from "../../types/schaltplan";
import "../../styles/schaltplan-enclosure-tab.css";

type Props = {
  document: PanelDocument;
  /** The cabinet catalogue: with it, a cabinet board's rows are grouped by module. */
  index?: CatalogIndex | null;
  selectedDeviceId: string | null;
  readOnly: boolean;
  onSelectDevice: (deviceId: string) => void;
  onAddDevice: (rowId: string) => void;
  onAddRow: () => void;
  /** Open the rail-template chooser (FI + 6 LS and friends). */
  onAddRowFromTemplate: () => void;
  onRemoveRow: (rowId: string) => void;
  onRenameRow: (rowId: string, label: string) => void;
  onChangeSlots: (rowId: string, slots: number) => void;
  /** Print this rail's BMK labels. Optional: the editor also renders where no printer exists. */
  onPrintRowLabels?: (rowId: string) => void;
};

export type RailRowProps = {
  row: PanelRow;
  /** Position in `document.rows`, for the row's accessible names. */
  index: number;
  canRemove: boolean;
  /** A cabinet rail's row: slots read-only, never removed here. */
  linked?: boolean;
  /** The board, for names that depend on it: a DIN-rail meter on a cabinet board is a Zwischenzähler (D7). */
  board?: Pick<PanelDocument, "enclosure"> | null;
} & Omit<Props, "document" | "index" | "onAddRow" | "onAddRowFromTemplate">;

export function RailRow({
  row,
  index,
  selectedDeviceId,
  readOnly,
  onSelectDevice,
  onAddDevice,
  onRemoveRow,
  onRenameRow,
  onChangeSlots,
  onPrintRowLabels,
  canRemove,
  linked = false,
  board = null,
}: RailRowProps) {
  const used = rowUsedSlots(row);
  const over = used > row.slots;
  const fill = Math.min(100, (used / Math.max(1, row.slots)) * 100);

  return (
    <section className="sp-rail">
      <header className="sp-rail-head">
        <input
          className="sp-rail-name"
          value={row.label}
          disabled={readOnly}
          onChange={(event) => onRenameRow(row.id, event.target.value)}
          aria-label={`Name der Reihe ${index + 1}`}
        />
        <div className="sp-rail-meta">
          <span className={over ? "sp-rail-slots sp-rail-slots--over" : "sp-rail-slots"}>
            {used} / {row.slots} TE
          </span>
          {linked ? null : (
            <label className="sp-rail-slot-input">
              <span className="visually-hidden">Plätze der Reihe {index + 1}</span>
              <input
                type="number"
                min={1}
                max={96}
                value={row.slots}
                disabled={readOnly}
                onChange={(event) => onChangeSlots(row.id, Number(event.target.value) || 1)}
              />
            </label>
          )}
          {onPrintRowLabels && (
            <button
              type="button"
              className="sp-rail-print"
              onClick={() => onPrintRowLabels(row.id)}
              title="BMK-Etiketten dieser Reihe drucken — Vorschau und Material im nächsten Schritt"
              aria-label={`BMK-Etiketten der Reihe ${index + 1} drucken`}
            >
              BMK
            </button>
          )}
          {!readOnly && canRemove && !linked && (
            <button
              type="button"
              className="sp-rail-remove"
              onClick={() => onRemoveRow(row.id)}
              aria-label={`Reihe ${index + 1} entfernen`}
            >
              ×
            </button>
          )}
        </div>
      </header>

      <div className="sp-rail-meter" aria-hidden="true">
        <span
          className={over ? "sp-rail-meter-fill sp-rail-meter-fill--over" : "sp-rail-meter-fill"}
          style={{ width: `${fill}%` }}
        />
      </div>

      <div className="sp-rail-track">
        {row.devices.map((device) => {
          const entry = catalogEntry(device.kind);
          const classes = ["sp-tile"];
          if (isGroupDevice(device)) classes.push("sp-tile--group");
          if (device.id === selectedDeviceId) classes.push("sp-tile--selected");
          return (
            <button
              key={device.id}
              type="button"
              className={classes.join(" ")}
              // Sized in TE so the row mirrors the real rail — a 4 TE FI is
              // visibly four modules wide. `min-width` in the stylesheet keeps
              // a 1 TE tile readable; TE only ever adds width, never removes it.
              style={{ width: `${device.te * 44}px` }}
              onClick={() => onSelectDevice(device.id)}
              title={`${deviceLabel(device.kind, board)} — ${device.label || "ohne Bezeichnung"}`}
            >
              <span className="sp-tile-icon">
                <DeviceSymbol kind={device.kind} size={20} />
              </span>
              <span className="sp-tile-bmk">{device.designation || entry.short}</span>
              <span className="sp-tile-sub">
                {isCircuitDevice(device) && device.circuit ? `Nr. ${device.circuit}` : device.rating || entry.short}
              </span>
              {isCircuitDevice(device) && device.label ? (
                <span className="sp-tile-label">{device.label}</span>
              ) : null}
              {hasTerminal(device) ? (
                // A dot, no text: the tile is already three lines on 1 TE.
                <span
                  className="sp-tile-terminal"
                  role="img"
                  aria-label="mit Reihenklemme"
                  title="Reihenklemme am Abgang"
                />
              ) : null}
            </button>
          );
        })}

        {!readOnly && (
          <button type="button" className="sp-tile sp-tile--add" onClick={() => onAddDevice(row.id)}>
            <span className="sp-tile-plus">+</span>
            <span className="sp-tile-sub">Gerät</span>
          </button>
        )}

        {row.devices.length === 0 && readOnly && <p className="sp-rail-empty">Keine Geräte erfasst.</p>}
      </div>
    </section>
  );
}

export function RailEditor({
  document,
  index = null,
  selectedDeviceId,
  readOnly,
  onSelectDevice,
  onAddDevice,
  onAddRow,
  onAddRowFromTemplate,
  onRemoveRow,
  onRenameRow,
  onChangeSlots,
  onPrintRowLabels,
}: Props) {
  const groups = index ? railEditorGroups(document, index) : null;
  const shared = { selectedDeviceId, readOnly, onSelectDevice, onAddDevice, onRemoveRow, onRenameRow, onChangeSlots, onPrintRowLabels };
  const position = new Map(document.rows.map((row, at) => [row.id, at] as const));
  const renderRow = (row: PanelRow, linked: boolean) => (
    <RailRow
      key={row.id}
      row={row}
      index={position.get(row.id) ?? 0}
      canRemove={document.rows.length > 1}
      linked={linked}
      board={document}
      {...shared}
    />
  );
  return (
    <div className="sp-rails">
      {groups
        ? groups.map((group) => (
            <section key={group.key} className="sp-rail-group" aria-label={group.title}>
              <h4 className="sp-rail-group-title">{group.title}</h4>
              {group.rows.map((row) => renderRow(row, group.linked))}
            </section>
          ))
        : document.rows.map((row) => renderRow(row, false))}
      {!readOnly && (
        <div className="sp-add-rail">
          <button type="button" className="sp-btn sp-btn--ghost" onClick={onAddRow}>
            + Reihe hinzufügen
          </button>
          <button
            type="button"
            className="sp-btn sp-btn--ghost"
            onClick={onAddRowFromTemplate}
            title="Fertig bestückte Reihe, z. B. ein FI mit sechs LS"
          >
            Reihe aus Vorlage…
          </button>
        </div>
      )}
    </div>
  );
}
