/**
 * Edit one device — the sheet that opens when a device is tapped.
 *
 * Which fields appear depends on the device's role, not on its kind: a
 * circuit gets Stromkreis-Nr., Verbraucher, Raum, Leitung and Phase; an FI
 * gets Bemessungsfehlerstrom and Typ; a Blindabdeckung gets almost nothing.
 * Showing every field for every kind would put "Leitung" on a blank cover
 * and make the common case (adding an LS) a scroll.
 *
 * Free-text inputs are paired with suggestion chips. Typing "NYM-J 3x1,5 mm²"
 * on a phone keyboard is the single slowest thing in this editor, and the
 * eight cables actually used cover nearly every circuit — but the field stays
 * free text, because the ninth cable exists.
 */
import { useEffect, useState } from "react";

import { DeviceSymbol } from "./DeviceSymbol";
import {
  CABLE_SUGGESTIONS,
  PHASE_OPTIONS,
  RATING_SUGGESTIONS,
  RCD_TYPE_OPTIONS,
  RESIDUAL_CURRENT_SUGGESTIONS,
  catalogEntry,
} from "../../utils/schaltplanDevices";
import { buildTopology } from "../../utils/schaltplanTopology";
import type { PanelDevice, PanelDocument, PhaseLabel } from "../../types/schaltplan";

type Props = {
  device: PanelDevice | null;
  document: PanelDocument;
  onChange: (patch: Partial<PanelDevice>) => void;
  onDelete: () => void;
  onMove: (direction: -1 | 1) => void;
  onClose: () => void;
  readOnly: boolean;
};

function Chips({
  values,
  active,
  onPick,
}: {
  values: readonly string[];
  active: string;
  onPick: (value: string) => void;
}) {
  return (
    <div className="sp-chips">
      {values.map((value) => (
        <button
          key={value || "none"}
          type="button"
          className={active === value ? "sp-chip-btn sp-chip-btn--active" : "sp-chip-btn"}
          onClick={() => onPick(value)}
        >
          {value || "—"}
        </button>
      ))}
    </div>
  );
}

export function DeviceInspector({
  device,
  document,
  onChange,
  onDelete,
  onMove,
  onClose,
  readOnly,
}: Props) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Reset the destructive confirmation whenever a different device is opened,
  // so an armed "Wirklich löschen?" cannot carry over onto the next tap.
  useEffect(() => {
    setConfirmDelete(false);
  }, [device?.id]);

  if (!device) return null;

  const entry = catalogEntry(device.kind);
  const groups = buildTopology(document).filter((group) => group.device !== null);
  const ratingSuggestions = RATING_SUGGESTIONS[device.kind] ?? [];

  const field = (label: string, node: React.ReactNode, hint?: string) => (
    <label className="sp-field">
      <span className="sp-field-label">{label}</span>
      {node}
      {hint ? <small className="sp-field-hint">{hint}</small> : null}
    </label>
  );

  return (
    <>
      <div className="sp-sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="sp-sheet sp-sheet--inspector" role="dialog" aria-modal="true" aria-label={entry.label}>
        <div className="sp-sheet-head">
          <div className="sp-inspector-head">
            <span className="sp-inspector-icon">
              <DeviceSymbol kind={device.kind} size={24} />
            </span>
            <div>
              <h3>{entry.label}</h3>
              <small>
                {entry.te === device.te ? `${device.te} TE` : `${device.te} TE (Standard ${entry.te})`}
                {entry.group ? " · öffnet eine FI-Gruppe" : ""}
              </small>
            </div>
          </div>
          <button type="button" className="sp-sheet-close" onClick={onClose} aria-label="Schließen">
            ×
          </button>
        </div>

        <div className="sp-sheet-body">
          <div className="sp-field-grid">
            {entry.circuit &&
              field(
                "Stromkreis-Nr.",
                <input
                  type="text"
                  inputMode="numeric"
                  value={device.circuit}
                  disabled={readOnly}
                  onChange={(event) => onChange({ circuit: event.target.value })}
                  placeholder="z. B. 7"
                />,
              )}
            {field(
              "Betriebsmittel (BMK)",
              <input
                type="text"
                value={device.designation}
                disabled={readOnly}
                onChange={(event) => onChange({ designation: event.target.value })}
                placeholder="z. B. F1.3"
              />,
            )}
          </div>

          {entry.circuit &&
            field(
              "Verbraucher / Bezeichnung",
              <input
                type="text"
                value={device.label}
                disabled={readOnly}
                onChange={(event) => onChange({ label: event.target.value })}
                placeholder="z. B. Steckdosen Küche"
              />,
            )}

          {entry.circuit &&
            field(
              "Raum",
              <input
                type="text"
                value={device.room}
                disabled={readOnly}
                onChange={(event) => onChange({ room: event.target.value })}
                placeholder="z. B. Küche"
              />,
            )}

          {field(
            // An FI or Hauptschalter has a Bemessungsstrom, not an Absicherung —
            // it protects nothing by itself. Getting that label wrong on the one
            // screen an electrician fills in is a small thing that reads as a
            // tool written by someone who has not opened a panel.
            entry.group ? "Bemessungsstrom" : "Absicherung",
            <>
              <input
                type="text"
                value={device.rating}
                disabled={readOnly}
                onChange={(event) => onChange({ rating: event.target.value })}
                placeholder={entry.ratingHint}
              />
              {!readOnly && ratingSuggestions.length > 0 && (
                <Chips
                  values={ratingSuggestions}
                  active={device.rating}
                  onPick={(value) => onChange({ rating: value })}
                />
              )}
            </>,
          )}

          {(device.kind === "rcd" || device.kind === "rcbo") && (
            <>
              {field(
                "Bemessungsfehlerstrom",
                <>
                  <input
                    type="text"
                    value={device.residual_current}
                    disabled={readOnly}
                    onChange={(event) => onChange({ residual_current: event.target.value })}
                    placeholder="30 mA"
                  />
                  {!readOnly && (
                    <Chips
                      values={RESIDUAL_CURRENT_SUGGESTIONS}
                      active={device.residual_current}
                      onPick={(value) => onChange({ residual_current: value })}
                    />
                  )}
                </>,
              )}
              {field(
                "FI-Typ",
                <Chips
                  values={RCD_TYPE_OPTIONS}
                  active={device.rcd_type}
                  onPick={(value) => (readOnly ? undefined : onChange({ rcd_type: value }))}
                />,
                "Typ B ist Pflicht, wo DC-Fehlerströme auftreten können (Wallbox, PV).",
              )}
            </>
          )}

          {entry.circuit && (
            <>
              {field(
                "Leitung",
                <>
                  <input
                    type="text"
                    value={device.cable}
                    disabled={readOnly}
                    onChange={(event) => onChange({ cable: event.target.value })}
                    placeholder="NYM-J 3x1,5 mm²"
                  />
                  {!readOnly && (
                    <Chips
                      values={CABLE_SUGGESTIONS}
                      active={device.cable}
                      onPick={(value) => onChange({ cable: value })}
                    />
                  )}
                </>,
              )}
              {field(
                "Phase",
                <Chips
                  values={PHASE_OPTIONS}
                  active={device.phase}
                  onPick={(value) => (readOnly ? undefined : onChange({ phase: value as PhaseLabel }))}
                />,
              )}
            </>
          )}

          <div className="sp-field-grid">
            {field(
              "Breite (TE)",
              <input
                type="number"
                min={1}
                max={24}
                value={device.te}
                disabled={readOnly}
                onChange={(event) =>
                  onChange({ te: Math.max(1, Math.min(24, Number(event.target.value) || 1)) })
                }
              />,
            )}
            {field(
              "Pole",
              <input
                type="number"
                min={1}
                max={4}
                value={device.poles}
                disabled={readOnly}
                onChange={(event) =>
                  onChange({ poles: Math.max(1, Math.min(4, Number(event.target.value) || 1)) })
                }
              />,
            )}
          </div>

          {entry.circuit &&
            field(
              "Eingespeist von",
              <select
                value={device.parent_id ?? ""}
                disabled={readOnly}
                onChange={(event) => onChange({ parent_id: event.target.value || null })}
              >
                <option value="">Automatisch (Gerät davor auf der Schiene)</option>
                {groups.map((group) => (
                  <option key={group.device!.id} value={group.device!.id}>
                    {`${group.device!.designation || "?"} ${catalogEntry(group.device!.kind).short}`}
                  </option>
                ))}
              </select>,
              "Nur ändern, wenn der Stromkreis nicht von dem FI versorgt wird, der auf der Schiene davor sitzt.",
            )}

          {field(
            "Notiz",
            <textarea
              rows={2}
              value={device.note}
              disabled={readOnly}
              onChange={(event) => onChange({ note: event.target.value })}
              placeholder="z. B. Klemmstelle im Nebenraum"
            />,
          )}
        </div>

        {!readOnly && (
          <div className="sp-sheet-actions">
            <button type="button" className="sp-btn" onClick={() => onMove(-1)}>
              ← Nach links
            </button>
            <button type="button" className="sp-btn" onClick={() => onMove(1)}>
              Nach rechts →
            </button>
            <button
              type="button"
              className={confirmDelete ? "sp-btn sp-btn--danger sp-btn--armed" : "sp-btn sp-btn--danger"}
              onClick={() => {
                if (!confirmDelete) {
                  setConfirmDelete(true);
                  return;
                }
                onDelete();
              }}
            >
              {confirmDelete ? "Wirklich löschen?" : "Löschen"}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
