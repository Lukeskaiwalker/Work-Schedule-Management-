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
 *
 * The header carries previous/next. Filling in a rail of twelve breakers is
 * tap, type, close, tap the next one — twelve times; two arrows in the sheet
 * make it type, next, type, next.
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
import { deviceWidthMm, formatMm, widthSuggestionsMm } from "../../utils/schaltplanStrip";
import { allDevices, buildTopology, isGroupDevice, opensGroup } from "../../utils/schaltplanTopology";
import type { PanelDevice, PanelDocument, PhaseLabel } from "../../types/schaltplan";

/** "17.5" / "17,5" / "" → 17.5 / 17.5 / null. Anything that is not a positive number clears the override. */
function parseWidthMm(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed.replace(",", "."));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** "Si F0 35 A — Vorsicherung": how a fuse reads in the "Eingespeist von" list. */
function fuseOptionLabel(fuse: PanelDevice): string {
  return `${["Si", fuse.designation || "?", fuse.rating].filter(Boolean).join(" ")} — Vorsicherung`;
}

type Props = {
  device: PanelDevice | null;
  document: PanelDocument;
  onChange: (patch: Partial<PanelDevice>) => void;
  onDelete: () => void;
  /** Copy this device into the next slot, with the next free BMK and Stromkreis-Nr. */
  onDuplicate: () => void;
  onMove: (direction: -1 | 1) => void;
  onClose: () => void;
  readOnly: boolean;
  /** Previous/next device in physical order. Optional: a caller without a board order gets disabled arrows. */
  hasPrevious?: boolean;
  hasNext?: boolean;
  onNavigate?: (direction: -1 | 1) => void;
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

function Chevron({ direction }: { direction: -1 | 1 }) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <polyline
        points={direction < 0 ? "12.5,4 6.5,10 12.5,16" : "7.5,4 13.5,10 7.5,16"}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function DeviceInspector({
  device,
  document,
  onChange,
  onDelete,
  onDuplicate,
  onMove,
  onClose,
  readOnly,
  hasPrevious = false,
  hasNext = false,
  onNavigate,
}: Props) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Reset the destructive confirmation whenever a different device is opened,
  // so an armed "Wirklich löschen?" cannot carry over onto the next tap.
  useEffect(() => {
    setConfirmDelete(false);
  }, [device?.id]);

  // "Breite (mm)" is typed into a draft string, not straight into the
  // number: a controlled input that round-trips through Number() on every
  // keystroke cannot hold "17." on its way to "17.5". Re-seeded only when a
  // different device opens, so typing is never undone under the finger.
  const [widthDraft, setWidthDraft] = useState("");
  const deviceId = device?.id ?? null;
  const deviceWidth = device?.width_mm ?? null;
  useEffect(() => {
    // Deliberately keyed on the id alone: including `deviceWidth` would
    // re-seed after every committed keystroke and eat a trailing decimal.
    setWidthDraft(deviceWidth != null ? String(deviceWidth) : "");
  }, [deviceId]);

  if (!device) return null;

  const defaultWidthMm = deviceWidthMm({ te: device.te, width_mm: null });
  const widthChips = widthSuggestionsMm(device.te);

  const entry = catalogEntry(device.kind);
  // A fuse that feeds circuits directly heads a group of its own. Its
  // parent_id is then not read at all — neither as "Eingespeist von" (it is
  // no load any more) nor as a Vorsicherung (a fuse-headed group has no
  // plate) — so the select is hidden and the head says what the fuse does.
  const fuseFeedsCircuits = device.kind === "fuse" && opensGroup(device, document);
  // Only the catalogue groups (FI/SLS/Hauptschalter) — fuses are listed
  // separately below, so a fuse that already heads a group is not shown twice.
  const groups = buildTopology(document).filter(
    (group) => group.device !== null && isGroupDevice(group.device),
  );
  // Neozed/NH blocks anywhere on the board. Offered as the Vorsicherung of an
  // FI/SLS/Hauptschalter, and as the direct feed of an RCBO or LS row. The
  // same parent_id field carries the choice.
  const fuses = allDevices(document).filter((d) => d.kind === "fuse" && d.id !== device.id);
  const ratingSuggestions = RATING_SUGGESTIONS[device.kind] ?? [];

  const field = (label: string, node: React.ReactNode, hint?: string) => (
    <label className="sp-field">
      <span className="sp-field-label">{label}</span>
      {node}
      {hint ? <small className="sp-field-hint">{hint}</small> : null}
    </label>
  );

  const roleNote = entry.group
    ? " · öffnet eine FI-Gruppe"
    : fuseFeedsCircuits
      ? " · Vorsicherung, speist Abgänge"
      : "";

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
                {` · ${formatMm(deviceWidthMm(device))} mm`}
                {roleNote}
              </small>
            </div>
          </div>
          <div className="sp-sheet-tools">
            <button
              type="button"
              className="sp-sheet-nav"
              onClick={() => onNavigate?.(-1)}
              disabled={!hasPrevious || !onNavigate}
              aria-label="Vorheriges Gerät"
            >
              <Chevron direction={-1} />
            </button>
            <button
              type="button"
              className="sp-sheet-nav"
              onClick={() => onNavigate?.(1)}
              disabled={!hasNext || !onNavigate}
              aria-label="Nächstes Gerät"
            >
              <Chevron direction={1} />
            </button>
            <button type="button" className="sp-sheet-close" onClick={onClose} aria-label="Schließen">
              ×
            </button>
          </div>
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

          {device.kind === "fuse" && (
            <div className="sp-field">
              <label className="sp-check">
                <input
                  type="checkbox"
                  checked={device.feeds_following === true}
                  disabled={readOnly}
                  onChange={(event) => onChange({ feeds_following: event.target.checked })}
                />
                <span className="sp-check-text">
                  Speist die folgenden Abgänge bis zum nächsten FI/Hauptschalter
                </span>
              </label>
              <small className="sp-field-hint">
                {fuseFeedsCircuits && !device.feeds_following
                  ? "Mindestens ein Abgang ist bereits auf diese Sicherung eingestellt — sie bildet deshalb schon eine eigene Gruppe."
                  : "Für FI/LS-Kombis oder eine LS-Reihe ohne FI: die Sicherung steht dann in der Legende als Vorsicherung dieser Stromkreise."}
              </small>
            </div>
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
              "Breite (mm)",
              <>
                <input
                  type="number"
                  inputMode="decimal"
                  min={1}
                  step="0.5"
                  value={widthDraft}
                  disabled={readOnly}
                  placeholder={formatMm(defaultWidthMm)}
                  aria-label="Breite in Millimetern"
                  onChange={(event) => {
                    setWidthDraft(event.target.value);
                    onChange({ width_mm: parseWidthMm(event.target.value) });
                  }}
                />
                {!readOnly && (
                  <Chips
                    values={widthChips.map(formatMm)}
                    active={device.width_mm != null ? formatMm(device.width_mm) : ""}
                    onPick={(value) => {
                      const picked = widthChips.find((candidate) => formatMm(candidate) === value);
                      if (picked == null) return;
                      setWidthDraft(String(picked));
                      onChange({ width_mm: picked });
                    }}
                  />
                )}
              </>,
              "Tatsächliche Einbaubreite — bestimmt die Länge des BMK-Etiketts auf dem Streifen.",
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

          {entry.group &&
            field(
              "Vorsicherung",
              <select
                value={device.parent_id ?? ""}
                disabled={readOnly}
                onChange={(event) => onChange({ parent_id: event.target.value || null })}
              >
                <option value="">Keine (direkt von der Sammelschiene)</option>
                {fuses.map((fuse) => (
                  <option key={fuse.id} value={fuse.id}>
                    {`${fuse.designation || "?"} Si${fuse.rating ? ` · ${fuse.rating}` : ""}`}
                  </option>
                ))}
              </select>,
              "Neozed- oder NH-Sicherung, die diesem FI vorgeschaltet ist. Sie erscheint in der Legende bei allen Stromkreisen dieser Gruppe.",
            )}
          {entry.circuit &&
            !fuseFeedsCircuits &&
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
                {/* A fuse's own feed is not modelled: offering another fuse here
                    would store a parent the topology never reads. */}
                {device.kind !== "fuse" &&
                  fuses.map((fuse) => (
                    <option key={fuse.id} value={fuse.id}>
                      {fuseOptionLabel(fuse)}
                    </option>
                  ))}
              </select>,
              "Nur ändern, wenn der Stromkreis nicht von dem FI davor auf der Schiene versorgt wird — etwa eine FI/LS-Kombi oder ein LS ohne FI direkt hinter einer Sicherung.",
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
          <div className="sp-sheet-actions sp-sheet-actions--grid">
            <button type="button" className="sp-btn" onClick={() => onMove(-1)}>
              ← Nach links
            </button>
            <button type="button" className="sp-btn" onClick={() => onMove(1)}>
              Nach rechts →
            </button>
            <button
              type="button"
              className="sp-btn"
              onClick={onDuplicate}
              title="Kopie rechts daneben — BMK und Stromkreis-Nr. werden hochgezählt"
            >
              Duplizieren
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
