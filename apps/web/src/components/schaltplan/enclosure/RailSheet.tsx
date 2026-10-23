/**
 * One DIN rail of the cabinet as tiles (docs/PANEL_ENCLOSURE.md D15, D16,
 * §11) — what a tap on a rail opens, at every zoom.
 *
 * A 1-TE breaker is 23 px wide at the drawing's largest zoom, far too small
 * for gloves; here every device is a full tile that opens the
 * DeviceInspector, whose ‹ › still walks the whole board. The tapped
 * device is highlighted and scrolled to the middle of the track: a full
 * 12-PLE rail is wider than the sheet on every tablet, and the breaker just
 * tapped near the right end would otherwise sit off screen. A rail gets its
 * row the first time it holds something, so "+ Gerät" and "Aus Vorlage
 * füllen" work on a rail that has no row yet. "Vorhandene Reihe hier einhängen" takes a row that is not in
 * the cabinet yet — offered on distribution rails (VT/VF) only, the same
 * rule as the module picker's row take-over, because a legacy row of
 * breakers belongs in a Verteilerfeld, never in the NAR or the RfZ.
 *
 * A rail reserved for WAGO terminals (docs/PANEL_ENCLOSURE_R2.md R2, §3.6)
 * says so: devices left on it from before keep their tiles and inspector
 * (tolerated), the banner offers the suggestion that moves them and the
 * field's close-up, and nothing new is offered — no "+ Gerät", no template.
 *
 * The tiles share RailEditor's `sp-tile` markup and 44 px-per-TE sizing but
 * not `RailRow` itself: `RailRow` brings its own name input, slot meter and
 * "+" tile, which this sheet already has as "Name der Reihe" and the 56 px
 * "+ Gerät" footer, and its tiles carry no "vorbestückt" mark.
 */
import { useLayoutEffect, useRef, useState, type Ref } from "react";

import { SheetFrame, SheetSection } from "./EnclosureSheetFrame";
import { formatPle, railInfo, type RailInfo } from "./sheetModel";
import { DeviceSymbol } from "../DeviceSymbol";
import { moduleArticle, type CatalogIndex } from "../../../utils/enclosureCatalog";
import { linkedRows, ROW_LABEL_MAX, suppliedDevices } from "../../../utils/enclosureLayout";
import { addDeviceToRail, assignRowToRail, fillRailFromTemplate } from "../../../utils/enclosureOps";
import { ROW_TEMPLATES } from "../../../utils/schaltplanDocumentOps";
import { catalogEntry, deviceLabel } from "../../../utils/schaltplanDevices";
import { isCircuitDevice, isGroupDevice } from "../../../utils/schaltplanTopology";
import type { FindingAction } from "./EnclosureFindings";
import { RESERVED_RAIL_TEXT } from "./TerminalCloseupSheet";
import type { DeviceChoiceRequest, EditDocument, RunEnclosureOp } from "./useSheetStack";
import { TERMINAL_RAIL_RESERVED } from "../../../utils/enclosureOpsDrag";
import type { PanelDevice, PanelDocument, PanelRow } from "../../../types/schaltplan";
import "../../../styles/schaltplan-enclosure-terminals.css";

type Props = {
  document: PanelDocument;
  index: CatalogIndex;
  moduleId: string;
  railKey: string;
  /** The device the fitter tapped in the drawing. */
  highlightDeviceId: string | null;
  readOnly: boolean;
  onOp: RunEnclosureOp;
  onEdit: EditDocument;
  /** A tile: open the DeviceInspector on top of this sheet. */
  onOpenDevice: (deviceId: string) => void;
  /** "+ Gerät": the tab opens the palette, pops it and calls `pick`. */
  onChooseDevice: (request: DeviceChoiceRequest) => void;
  onBack?: () => void;
  onClose: () => void;
  /** One of the field's two terminal rails (R2): nothing new goes on it. */
  reserved?: boolean;
  /** The finding's action for the devices still on it ("Vorschlag ausführen"). */
  reservedAction?: FindingAction | null;
  /** "Klemmen Feld {n}": the field's close-up. */
  onOpenTerminals?: () => void;
};


function ReservedBanner({ field, withDevices, readOnly, action, onOpenTerminals }: {
  field: number;
  withDevices: boolean;
  readOnly: boolean;
  action: FindingAction | null;
  onOpenTerminals?: () => void;
}) {
  return (
    <div className="sp-encl-reserved" role="note">
      <p>{withDevices ? RESERVED_RAIL_TEXT : TERMINAL_RAIL_RESERVED}</p>
      <div className="sp-term-banner-actions">
        {action && !readOnly ? (
          <button type="button" className="sp-btn sp-btn--primary sp-encl-target" onClick={action.run}>
            {action.label}
          </button>
        ) : null}
        {onOpenTerminals ? (
          <button type="button" className="sp-btn sp-encl-target" onClick={onOpenTerminals}>
            {`Klemmen Feld ${field}`}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Templates that put something on the rail ("Leere Reihe" would fill nothing). */
const FILL_TEMPLATES = ROW_TEMPLATES.filter((template) => template.kinds.length > 0);

type TileProps = {
  device: PanelDevice;
  document: PanelDocument;
  highlighted: boolean;
  supplied: boolean;
  onOpen: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
};

function Tile({ device, document, highlighted, supplied, onOpen, buttonRef }: TileProps) {
  const entry = catalogEntry(device.kind);
  const kind = deviceLabel(device.kind, document);
  const name = device.designation || entry.short;
  const classes = ["sp-tile", "sp-encl-tile"];
  if (isGroupDevice(device)) classes.push("sp-tile--group");
  if (highlighted) classes.push("sp-tile--selected");
  return (
    <li className="sp-encl-tile-cell">
      <button
        ref={buttonRef}
        type="button"
        className={classes.join(" ")}
        // 44 px per TE, as in the rail editor: a 4 TE FI reads four times an LS.
        style={{ width: `${Math.max(1, device.te) * 44}px` }}
        aria-current={highlighted ? "true" : undefined}
        aria-label={[name, kind, device.label, supplied ? "vorbestückt" : ""].filter(Boolean).join(", ")}
        onClick={onOpen}
      >
        <span className="sp-tile-icon">
          <DeviceSymbol kind={device.kind} size={20} />
        </span>
        <span className="sp-tile-bmk">{name}</span>
        <span className="sp-tile-sub">
          {isCircuitDevice(device) && device.circuit ? `Nr. ${device.circuit}` : device.rating || entry.short}
        </span>
        {isCircuitDevice(device) && device.label ? <span className="sp-tile-label">{device.label}</span> : null}
        {supplied ? <span className="sp-encl-tile-supplied">vorbestückt</span> : null}
      </button>
    </li>
  );
}

type ToolsProps = {
  document: PanelDocument;
  index: CatalogIndex;
  rail: RailInfo;
  onOp: RunEnclosureOp;
};

function TemplateFill({ rail, onOp }: Omit<ToolsProps, "document" | "index">) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="sp-btn sp-encl-target" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        Aus Vorlage füllen
      </button>
      {open ? (
        <div className="sp-palette-grid">
          {FILL_TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              className="sp-palette-item sp-encl-item"
              onClick={() => {
                setOpen(false);
                onOp((current, idx) => fillRailFromTemplate(current, idx, rail.moduleId, rail.railKey, template.id));
              }}
            >
              <span className="sp-palette-text">
                <b>{template.label}</b>
                <small>{template.hint}</small>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

/** Rows not in the cabinet that hold devices: what can be hung onto an empty distribution rail. */
function outsideRows(document: PanelDocument, index: CatalogIndex): PanelRow[] {
  const links = linkedRows(document, index);
  return document.rows.filter((row) => !links.has(row.id) && row.devices.length > 0);
}

function RowAdoption({ document, index, rail, onOp }: ToolsProps) {
  const [open, setOpen] = useState(false);
  const rows = outsideRows(document, index);
  if (rows.length === 0) return null;
  return (
    <>
      <button type="button" className="sp-btn sp-encl-target" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        Vorhandene Reihe hier einhängen
      </button>
      {open ? (
        <div className="sp-palette-grid">
          {rows.map((row) => (
            <button
              key={row.id}
              type="button"
              className="sp-palette-item sp-encl-item"
              onClick={() => {
                setOpen(false);
                onOp((current, idx) => assignRowToRail(current, idx, rail.moduleId, rail.railKey, row.id));
              }}
            >
              <span className="sp-palette-text">
                <b>{`${row.label || "Reihe"} · ${row.devices.length} ${row.devices.length === 1 ? "Gerät" : "Geräte"}`}</b>
                <small>Nicht im Schrank</small>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

/**
 * Bring the highlighted tile into the track's view, centred. `inline:
 * "center"` moves only the track (the page root clips horizontally);
 * `block: "nearest"` scrolls the sheet body only if the track is out of it.
 */
function useCentredTile(highlightDeviceId: string | null) {
  const tile = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!highlightDeviceId) return;
    tile.current?.scrollIntoView?.({ block: "nearest", inline: "center" });
  }, [highlightDeviceId]);
  return tile;
}

export function RailSheet(props: Props) {
  const { document, index, moduleId, railKey, highlightDeviceId, readOnly, onOp, onEdit, onOpenDevice, onChooseDevice, onBack, onClose } = props;
  const reserved = props.reserved ?? false;
  const highlightedTile = useCentredTile(highlightDeviceId);
  const rail = railInfo(document, index, moduleId, railKey);

  if (!rail) {
    return (
      <SheetFrame title="Hutschiene" onBack={onBack} onClose={onClose}>
        <p className="sp-encl-empty">Diese Hutschiene gibt es im Schrank nicht mehr.</p>
      </SheetFrame>
    );
  }

  const module = document.enclosure!.modules.find((candidate) => candidate.id === moduleId)!;
  const supplied = suppliedDevices(document, index);
  const devices = rail.row?.devices ?? [];
  const empty = devices.length === 0;
  const distribution = rail.zone.type === "VT" || rail.zone.type === "VF";
  const addDevice = () =>
    onChooseDevice({
      label: rail.row?.label || rail.title,
      pick: (kind) =>
        onOp(
          (current, idx) => addDeviceToRail(current, idx, moduleId, railKey, kind),
          (result) => {
            if (result.deviceId) onOpenDevice(result.deviceId);
          },
        ),
    });
  const rename = (label: string) =>
    onEdit((current) => ({ ...current, rows: current.rows.map((row) => (row.id === rail.row?.id ? { ...row, label } : row)) }));
  const subtitle = [
    moduleArticle(module, index),
    `${formatPle(rail.usedPle)} / ${rail.rail.ple} PLE`,
    rail.rail.mount === "busbar" ? "Sammelschiene" : "",
    rail.rail.retired ? "ausgemustert — Geräte umsetzen" : "",
    reserved ? "für Reihenklemmen reserviert" : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <SheetFrame
      title={rail.title}
      subtitle={subtitle}
      onBack={onBack}
      onClose={onClose}
      className="sp-encl-rail-sheet"
      footer={
        readOnly || rail.rail.retired || reserved ? undefined : (
          <button type="button" className="sp-btn sp-btn--primary sp-encl-target" onClick={addDevice}>
            + Gerät
          </button>
        )
      }
    >
      {reserved ? (
        <ReservedBanner field={rail.field} withDevices={!empty} readOnly={readOnly} action={props.reservedAction ?? null} onOpenTerminals={props.onOpenTerminals} />
      ) : null}
      {rail.row ? (
        <label className="sp-field">
          <span className="sp-field-label">Name der Reihe</span>
          <input type="text" value={rail.row.label} maxLength={ROW_LABEL_MAX} disabled={readOnly} onChange={(event) => rename(event.target.value)} />
        </label>
      ) : null}
      {empty ? (
        <p className="sp-encl-empty">Noch keine Geräte auf dieser Hutschiene.</p>
      ) : (
        <ul className="sp-rail-track sp-encl-rail-track" aria-label="Geräte auf der Hutschiene">
          {devices.map((device) => (
            <Tile
              key={device.id}
              device={device}
              document={document}
              highlighted={device.id === highlightDeviceId}
              buttonRef={device.id === highlightDeviceId ? highlightedTile : undefined}
              supplied={supplied.has(device.id)}
              onOpen={() => onOpenDevice(device.id)}
            />
          ))}
        </ul>
      )}
      {!readOnly && empty && !rail.rail.retired && !reserved ? (
        <SheetSection title="Hutschiene bestücken">
          <TemplateFill rail={rail} onOp={onOp} />
          {distribution ? <RowAdoption document={document} index={index} rail={rail} onOp={onOp} /> : null}
        </SheetSection>
      ) : null}
    </SheetFrame>
  );
}
