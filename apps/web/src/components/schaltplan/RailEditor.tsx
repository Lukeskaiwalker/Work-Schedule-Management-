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
 */
import { DeviceSymbol } from "./DeviceSymbol";
import { catalogEntry, rowUsedSlots } from "../../utils/schaltplanDevices";
import { isCircuitDevice, isGroupDevice } from "../../utils/schaltplanTopology";
import type { PanelDocument, PanelRow } from "../../types/schaltplan";

type Props = {
  document: PanelDocument;
  selectedDeviceId: string | null;
  readOnly: boolean;
  onSelectDevice: (deviceId: string) => void;
  onAddDevice: (rowId: string) => void;
  onAddRow: () => void;
  onRemoveRow: (rowId: string) => void;
  onRenameRow: (rowId: string, label: string) => void;
  onChangeSlots: (rowId: string, slots: number) => void;
};

function RailRow({
  row,
  index,
  selectedDeviceId,
  readOnly,
  onSelectDevice,
  onAddDevice,
  onRemoveRow,
  onRenameRow,
  onChangeSlots,
  canRemove,
}: {
  row: PanelRow;
  index: number;
  canRemove: boolean;
} & Omit<Props, "document" | "onAddRow">) {
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
          {!readOnly && canRemove && (
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
              title={`${entry.label} — ${device.label || "ohne Bezeichnung"}`}
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
  selectedDeviceId,
  readOnly,
  onSelectDevice,
  onAddDevice,
  onAddRow,
  onRemoveRow,
  onRenameRow,
  onChangeSlots,
}: Props) {
  return (
    <div className="sp-rails">
      {document.rows.map((row, index) => (
        <RailRow
          key={row.id}
          row={row}
          index={index}
          canRemove={document.rows.length > 1}
          selectedDeviceId={selectedDeviceId}
          readOnly={readOnly}
          onSelectDevice={onSelectDevice}
          onAddDevice={onAddDevice}
          onRemoveRow={onRemoveRow}
          onRenameRow={onRenameRow}
          onChangeSlots={onChangeSlots}
        />
      ))}
      {!readOnly && (
        <button type="button" className="sp-btn sp-btn--ghost sp-add-rail" onClick={onAddRow}>
          + Reihe hinzufügen
        </button>
      )}
    </div>
  );
}
