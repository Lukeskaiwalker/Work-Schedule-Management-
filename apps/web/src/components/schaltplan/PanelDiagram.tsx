/**
 * The Übersichtsschaltplan itself — a live SVG single-line diagram.
 *
 * Nothing here is drawn by hand: the picture is a pure function of the panel
 * document, via `buildTopology`. That is what lets the legend, the diagram
 * and the PDF agree by construction instead of by discipline.
 *
 * Geometry mirrors `apps/api/app/services/schaltplan_pdf.py` (supply block →
 * busbar → group boxes → circuit columns) so the tablet and the printed sheet
 * are recognisably the same drawing. SVG's y-axis points down, so the numbers
 * are not literally the same constants — the bands and proportions are.
 *
 * Panning is native overflow scrolling rather than a custom pointer handler.
 * On a tablet held in one hand that means momentum, rubber-banding and
 * two-finger scroll all behave the way the OS does them; a hand-rolled drag
 * would have to re-implement each one and would fight the page scroll.
 * Zoom is explicit buttons for the same reason: pinch gestures are
 * unreliable with work gloves, and a stepped zoom is repeatable.
 */
import { useMemo, useRef, useState } from "react";

import { DeviceSymbol } from "./DeviceSymbol";
import { buildTopology } from "../../utils/schaltplanTopology";
import { catalogEntry } from "../../utils/schaltplanDevices";
import type { PanelDevice, PanelDocument, PanelGroup } from "../../types/schaltplan";

const COL_W = 104;
const GROUP_GAP = 26;
const GROUP_MIN_W = 178;
const SUPPLY_W = 236;
const BAND_X0 = SUPPLY_W + 40;

const Y_SUPPLY_TOP = 16;
const Y_SUPPLY_BOT = 104;
const Y_BUS = 132;
const Y_GROUP_TOP = 162;
const Y_GROUP_BOT = 216;
const Y_SUBBUS = 240;
const Y_DEV_TOP = 264;
const Y_DEV_BOT = 320;
const Y_CHIP = 336;
const Y_TEXT = 372;
const CANVAS_H = 470;

const ZOOM_STEPS = [0.6, 0.75, 0.9, 1, 1.25, 1.5, 2];

type Props = {
  document: PanelDocument;
  selectedDeviceId: string | null;
  onSelect: (deviceId: string | null) => void;
  fedFrom?: string | null;
  designation: string;
  /** Read-only render used by the print stylesheet — hides the zoom chrome. */
  compact?: boolean;
};

function groupWidth(group: PanelGroup): number {
  return Math.max(GROUP_MIN_W, COL_W * Math.max(1, group.children.length));
}

/**
 * Word wrap by estimated width.
 *
 * SVG has no text wrapping and measuring per label would mean a layout pass
 * per keystroke. An average-character-width estimate is off by a few percent
 * on extreme strings, which costs at most one early break — acceptable for a
 * label that is also spelled out in full in the legend and the inspector.
 */
function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const clean = text.trim();
  if (!clean) return [];
  const words = clean.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word.length > maxChars ? `${word.slice(0, maxChars - 1)}…` : word;
    }
    if (lines.length === maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines.slice(0, maxLines);
}

function CircuitColumn({
  device,
  x,
  selected,
  onSelect,
}: {
  device: PanelDevice;
  x: number;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const cx = x + COL_W / 2;
  const entry = catalogEntry(device.kind);
  const boxW = COL_W - 22;
  const labelLines = wrap(device.label || "—", 15, 2);
  const meta = [device.room, device.cable, device.phase === "-" ? "" : device.phase].filter(Boolean);

  return (
    <g
      className={selected ? "sp-circuit sp-circuit--selected" : "sp-circuit"}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(device.id);
      }}
      role="button"
      tabIndex={0}
      aria-label={`${entry.label} ${device.designation} ${device.label}`}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(device.id);
        }
      }}
    >
      {/* Generous invisible hit area — a 14 px breaker box is not a tap target. */}
      <rect x={x} y={Y_SUBBUS} width={COL_W} height={CANVAS_H - Y_SUBBUS - 20} fill="transparent" />
      <line x1={cx} y1={Y_SUBBUS} x2={cx} y2={Y_DEV_TOP} className="sp-wire" />
      <rect
        x={cx - boxW / 2}
        y={Y_DEV_TOP}
        width={boxW}
        height={Y_DEV_BOT - Y_DEV_TOP}
        rx={6}
        className="sp-device-box"
      />
      <g transform={`translate(${cx - boxW / 2 + 6}, ${Y_DEV_TOP + 8})`} className="sp-device-glyph">
        <DeviceSymbol kind={device.kind} size={20} />
      </g>
      <text x={cx + 6} y={Y_DEV_TOP + 22} className="sp-device-bmk">
        {device.designation || "—"}
      </text>
      <text x={cx + 6} y={Y_DEV_TOP + 38} className="sp-device-rating">
        {device.rating || entry.short}
      </text>

      {device.circuit ? (
        <>
          <rect x={cx - 17} y={Y_CHIP} width={34} height={20} rx={5} className="sp-chip" />
          <text x={cx} y={Y_CHIP + 14} className="sp-chip-text" textAnchor="middle">
            {device.circuit}
          </text>
        </>
      ) : (
        <text x={cx} y={Y_CHIP + 14} className="sp-chip-missing" textAnchor="middle">
          Nr.?
        </text>
      )}

      {labelLines.map((line, index) => (
        <text
          key={index}
          x={cx}
          y={Y_TEXT + index * 14}
          textAnchor="middle"
          className="sp-circuit-label"
        >
          {line}
        </text>
      ))}
      {meta.slice(0, 2).map((value, index) => (
        <text
          key={value + index}
          x={cx}
          y={Y_TEXT + labelLines.length * 14 + index * 13}
          textAnchor="middle"
          className="sp-circuit-meta"
        >
          {wrap(value, 17, 1)[0]}
        </text>
      ))}
    </g>
  );
}

function GroupBlock({
  group,
  x,
  selectedDeviceId,
  onSelect,
}: {
  group: PanelGroup;
  x: number;
  selectedDeviceId: string | null;
  onSelect: (id: string) => void;
}) {
  const width = groupWidth(group);
  const cx = x + width / 2;
  const device = group.device;
  const entry = device ? catalogEntry(device.kind) : null;
  const detail = device
    ? [device.rating, device.residual_current, device.rcd_type ? `Typ ${device.rcd_type}` : ""]
        .filter(Boolean)
        .join(" · ")
    : "direkt von der Sammelschiene";

  const firstCx = x + COL_W / 2;
  const lastCx = x + COL_W * (group.children.length - 0.5);

  return (
    <g>
      <line x1={cx} y1={Y_BUS} x2={cx} y2={Y_GROUP_TOP} className="sp-wire sp-wire--thick" />
      <g
        className={
          device === null
            ? "sp-group sp-group--unprotected"
            : selectedDeviceId === device.id
              ? "sp-group sp-group--selected"
              : "sp-group"
        }
        onClick={(event) => {
          if (!device) return;
          event.stopPropagation();
          onSelect(device.id);
        }}
        role={device ? "button" : undefined}
        tabIndex={device ? 0 : undefined}
        onKeyDown={(event) => {
          if (!device) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect(device.id);
          }
        }}
      >
        <rect
          x={x}
          y={Y_GROUP_TOP}
          width={width}
          height={Y_GROUP_BOT - Y_GROUP_TOP}
          rx={8}
          className="sp-group-box"
        />
        {device ? (
          <>
            <g transform={`translate(${x + 12}, ${Y_GROUP_TOP + 14})`} className="sp-group-glyph">
              <DeviceSymbol kind={device.kind} size={26} />
            </g>
            <text x={x + 48} y={Y_GROUP_TOP + 24} className="sp-group-title">
              {`${device.designation || ""} ${entry?.short ?? ""}`.trim()}
            </text>
            <text x={x + 48} y={Y_GROUP_TOP + 42} className="sp-group-detail">
              {detail || "—"}
            </text>
          </>
        ) : (
          <>
            <text x={cx} y={Y_GROUP_TOP + 24} textAnchor="middle" className="sp-group-title sp-group-title--warn">
              OHNE FI-SCHUTZ
            </text>
            <text x={cx} y={Y_GROUP_TOP + 42} textAnchor="middle" className="sp-group-detail">
              {detail}
            </text>
          </>
        )}
      </g>

      {group.children.length > 0 && (
        <>
          <line x1={cx} y1={Y_GROUP_BOT} x2={cx} y2={Y_SUBBUS} className="sp-wire sp-wire--thick" />
          <line
            x1={Math.min(firstCx, cx)}
            y1={Y_SUBBUS}
            x2={Math.max(lastCx, cx)}
            y2={Y_SUBBUS}
            className="sp-subbus"
          />
          {group.children.map((child, index) => (
            <CircuitColumn
              key={child.id}
              device={child}
              x={x + COL_W * index}
              selected={selectedDeviceId === child.id}
              onSelect={onSelect}
            />
          ))}
        </>
      )}
    </g>
  );
}

export function PanelDiagram({
  document,
  selectedDeviceId,
  onSelect,
  fedFrom,
  designation,
  compact = false,
}: Props) {
  const [zoomIndex, setZoomIndex] = useState(3);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const groups = useMemo(() => buildTopology(document), [document]);
  const totalWidth = useMemo(() => {
    const groupsWidth =
      groups.reduce((sum, group) => sum + groupWidth(group), 0) +
      GROUP_GAP * Math.max(0, groups.length - 1);
    return Math.max(BAND_X0 + groupsWidth + 40, 900);
  }, [groups]);

  const zoom = ZOOM_STEPS[zoomIndex];
  const supply = document.supply;

  let cursor = BAND_X0;

  return (
    <div className="sp-diagram">
      {!compact && (
        <div className="sp-diagram-toolbar">
          <span className="sp-diagram-hint">Tippe ein Gerät an, um es zu bearbeiten</span>
          <div className="sp-zoom">
            <button
              type="button"
              onClick={() => setZoomIndex((index) => Math.max(0, index - 1))}
              disabled={zoomIndex === 0}
              aria-label="Verkleinern"
            >
              −
            </button>
            <span className="sp-zoom-value">{Math.round(zoom * 100)} %</span>
            <button
              type="button"
              onClick={() => setZoomIndex((index) => Math.min(ZOOM_STEPS.length - 1, index + 1))}
              disabled={zoomIndex === ZOOM_STEPS.length - 1}
              aria-label="Vergrößern"
            >
              +
            </button>
            <button
              type="button"
              className="sp-zoom-fit"
              onClick={() => {
                const available = scrollRef.current?.clientWidth ?? 0;
                if (!available) return;
                // Pick the largest step that still shows the whole drawing.
                const target = available / totalWidth;
                let best = 0;
                ZOOM_STEPS.forEach((step, index) => {
                  if (step <= target) best = index;
                });
                setZoomIndex(best);
                scrollRef.current?.scrollTo({ left: 0 });
              }}
            >
              Einpassen
            </button>
          </div>
        </div>
      )}

      <div className="sp-diagram-scroll" ref={scrollRef}>
        <svg
          width={totalWidth * zoom}
          height={CANVAS_H * zoom}
          viewBox={`0 0 ${totalWidth} ${CANVAS_H}`}
          className="sp-canvas"
          onClick={() => onSelect(null)}
          role="img"
          aria-label={`Übersichtsschaltplan ${designation}`}
        >
          <rect x={0} y={0} width={totalWidth} height={CANVAS_H} className="sp-canvas-bg" />

          {/* Einspeisung */}
          <g>
            <rect
              x={16}
              y={Y_SUPPLY_TOP}
              width={SUPPLY_W}
              height={Y_SUPPLY_BOT - Y_SUPPLY_TOP}
              rx={8}
              className="sp-supply-box"
            />
            <text x={28} y={Y_SUPPLY_TOP + 20} className="sp-supply-title">
              EINSPEISUNG
            </text>
            <text x={28} y={Y_SUPPLY_TOP + 38} className="sp-supply-line">
              {`${supply.system}  ${supply.voltage}`.trim()}
            </text>
            <text x={28} y={Y_SUPPLY_TOP + 54} className="sp-supply-line">
              {supply.incoming ? `Zuleitung: ${wrap(supply.incoming, 26, 1)[0]}` : "Zuleitung: —"}
            </text>
            <text x={28} y={Y_SUPPLY_TOP + 70} className="sp-supply-line">
              {`Von: ${fedFrom || "Hausanschluss / Netz"}`}
            </text>
            <line
              x1={16 + SUPPLY_W / 2}
              y1={Y_SUPPLY_BOT}
              x2={16 + SUPPLY_W / 2}
              y2={Y_BUS}
              className="sp-wire sp-wire--thick"
            />
          </g>

          {/* Sammelschiene */}
          <line x1={16} y1={Y_BUS} x2={totalWidth - 24} y2={Y_BUS} className="sp-busbar" />
          <text x={totalWidth - 24} y={Y_BUS - 8} textAnchor="end" className="sp-busbar-label">
            SAMMELSCHIENE L1 · L2 · L3 · N · PE
          </text>

          {groups.map((group) => {
            const x = cursor;
            cursor += groupWidth(group) + GROUP_GAP;
            return (
              <GroupBlock
                key={group.device?.id ?? "supply-group"}
                group={group}
                x={x}
                selectedDeviceId={selectedDeviceId}
                onSelect={onSelect}
              />
            );
          })}

          {groups.length === 0 && (
            <text x={BAND_X0} y={Y_GROUP_TOP + 24} className="sp-empty-hint">
              Noch keine Geräte — füge unten einen FI oder Leitungsschutzschalter hinzu.
            </text>
          )}
        </svg>
      </div>
    </div>
  );
}
