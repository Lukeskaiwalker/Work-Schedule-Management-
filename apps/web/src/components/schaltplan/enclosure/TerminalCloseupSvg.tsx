/**
 * The close-up drawing of a field's two terminal rails
 * (docs/PANEL_ENCLOSURE_R2.md §7.2): ONE svg for both rails, in one
 * horizontal scroller of its own (the app root clips overflow-x), so the
 * rails line up, scroll together, and one drop test covers both.
 *
 * Every terminal is a tap target ("Klemme X3.2 …"): a tap selects it and
 * its strip; the sheet shows its texts in full. Each strip is one group
 * with `data-drag-device`, so on an editable board the same long-press
 * drag as the cabinet drawing (`useLongPressDrag`) moves the WHOLE strip —
 * onto the other rail, or to another place on its own. The drop is
 * measured with the op's own number (`measure`): what does not fit is
 * refused before release, with the reason in the label. The label and the
 * ghost float in a fixed layer on the page (`DragOverlay`, as on the cabinet
 * drawing), so neither the scroller nor the sheet's body can scroll them
 * away; the line above the drawing is their polite echo for screen readers.
 * The buttons under the drawing stay as the fallback (the smallest strip is
 * 26 px).
 */
import { useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { DragOverlay } from "./EnclosureDragLayer";
import { stripLabelText, stripSlot, type StripDrop } from "./enclosureDropTargets";
import {
  BODY_PX,
  CLOSEUP_FIT,
  MARKER_ZONE_PX,
  PAD_PX,
  PX_PER_MM,
  RAIL_GAP_PX,
  xOf,
  type CloseupLayout,
  type ItemLayout,
  type RailLayout,
} from "./terminalCloseupLayout";
import { useLongPressDrag } from "./useLongPressDrag";
import type { Point } from "./dragMachine";
import type { StripTarget } from "../../../utils/enclosureOpsTerminals";
import type { LabelFit } from "../../../utils/labelFit";
import type { TerminalCloseup } from "../../../types/panelEnclosure";

export interface TerminalCloseupSvgProps {
  closeup: TerminalCloseup;
  layout: CloseupLayout;
  readOnly: boolean;
  selectedStripId: string | null;
  selectedItemKey: string | null;
  onSelectStrip: (stripId: string) => void;
  onSelectItem: (key: string, stripId: string | null) => void;
  /** A strip dropped by drag (editable boards only). */
  onMoveStrip?: (stripId: string, target: StripTarget) => void;
  /** How far the strip at (`rail`, `at`) would run its rails over (`stripMoveOverMm`); 0 = it fits. */
  measure?: (stripId: string, rail: 0 | 1, at: number) => number;
}

const LEVEL_TOP_PX = 62;
const LEVEL_H_PX = 24;
const LEVEL_GAP_PX = 4;
const PART_Y_PX = 30;
const RAIL_BAR_PX = 35;
const BAR_PX = 3;
const HEADING_BASELINE_PX = 20;

function activateOnKey(event: KeyboardEvent<SVGElement>, activate: () => void) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  activate();
}

/** A fitted text centred at (cx, cy); `along`: drawn along the column (rotated) unless the fit turned it across. */
function Fitted({ fit, cx, cy, className, turned, data }: {
  fit: LabelFit;
  cx: number;
  cy: number;
  className: string;
  turned: boolean;
  data?: Record<string, string>;
}) {
  if (!fit.text) return null;
  return (
    <text
      className={className}
      x={cx}
      y={cy}
      textAnchor="middle"
      dominantBaseline="central"
      fontSize={fit.size}
      transform={turned ? `rotate(-90 ${cx} ${cy})` : undefined}
      {...data}
    >
      {fit.text}
    </text>
  );
}

function itemName(item: ItemLayout): string {
  const parts = [`Klemme ${item.item.xLabel}.${item.position}`, item.item.partId, item.item.marker, item.item.forText].filter(Boolean);
  return parts.join(" · ");
}

function Item({ entry, rail, selected, onSelect }: { entry: ItemLayout; rail: RailLayout; selected: boolean; onSelect: () => void }) {
  const cx = entry.x + entry.w / 2;
  const line = (entry.w - 4) / 4;
  const columnY = rail.textY + rail.textH / 2;
  const levels = entry.w >= 14 ? entry.item.levels : [];
  return (
    <g className={`sp-term-item sp-term-item--${entry.tone}${selected ? " is-selected" : ""}`} data-item={entry.key}>
      <rect className="sp-term-body" x={entry.x} y={rail.bodyY} width={entry.w} height={BODY_PX} />
      <Fitted
        fit={entry.marker}
        cx={cx}
        cy={rail.markerY + MARKER_ZONE_PX / 2}
        className="sp-term-marker"
        turned={entry.marker.rotated}
        data={{ "data-marker-for": entry.key, "data-rotated": String(entry.marker.rotated) }}
      />
      <Fitted fit={entry.part} cx={cx} cy={rail.bodyY + PART_Y_PX} className="sp-term-part" turned={entry.part.rotated} />
      {levels.map((level, i) => {
        const y = rail.bodyY + LEVEL_TOP_PX + i * (LEVEL_H_PX + LEVEL_GAP_PX);
        return (
          <g key={`${level}:${i}`} className="sp-term-level">
            <rect x={entry.x + 2} y={y} width={entry.w - 4} height={LEVEL_H_PX} rx={3} />
            <text x={cx} y={y + LEVEL_H_PX / 2} textAnchor="middle" dominantBaseline="central" fontSize={CLOSEUP_FIT.text.min}>
              {level}
            </text>
          </g>
        );
      })}
      <Fitted fit={entry.forText} cx={cx - line} cy={columnY} className="sp-term-for" turned={!entry.forText.rotated} />
      <Fitted fit={entry.cable} cx={cx + line} cy={columnY} className="sp-term-cable" turned={!entry.cable.rotated} />
      {entry.item.kind === "end_plate" ? null : (
        <rect
          className="sp-term-hit"
          x={entry.x}
          y={rail.markerY}
          width={entry.w}
          height={rail.bottom - rail.markerY}
          role="button"
          tabIndex={-1}
          aria-label={itemName(entry)}
          aria-pressed={selected}
          onClick={onSelect}
          onKeyDown={(event) => activateOnKey(event, onSelect)}
        />
      )}
    </g>
  );
}

type Props = TerminalCloseupSvgProps;

function Rail({ rail, props, dragging }: { rail: RailLayout; props: Props; dragging: string | null }) {
  const { readOnly, selectedStripId, selectedItemKey, onSelectStrip, onSelectItem } = props;
  const railY = rail.bodyY + BODY_PX / 2 - RAIL_BAR_PX / 2;
  const capacityPx = rail.rail.capacityMm * PX_PER_MM;
  const plates = rail.items.filter((entry) => entry.item.stripId === null);
  return (
    <g className="sp-term-rail" data-rail={rail.position}>
      <text className="sp-term-heading" x={PAD_PX} y={rail.top + HEADING_BASELINE_PX} fontSize={CLOSEUP_FIT.heading}>
        {rail.heading}
      </text>
      {rail.chip ? (
        <g className={`sp-term-chip${rail.rail.insulated ? " sp-term-chip--factory" : ""}`}>
          <rect x={rail.chipX} y={rail.top + 4} width={rail.chipW} height={22} rx={11} />
          <text x={rail.chipX + rail.chipW / 2} y={rail.top + 15} textAnchor="middle" dominantBaseline="central" fontSize={CLOSEUP_FIT.text.max}>
            {rail.chip}
          </text>
        </g>
      ) : null}
      <rect className="sp-term-railbar" x={PAD_PX} y={railY} width={capacityPx} height={RAIL_BAR_PX} />
      <line className="sp-term-railend" x1={PAD_PX + capacityPx} x2={PAD_PX + capacityPx} y1={rail.markerY} y2={rail.textY} />
      {rail.devices.map((device) => (
        <g key={device.deviceId} className="sp-term-device">
          <rect x={device.x} y={rail.bodyY} width={device.w} height={BODY_PX} />
          <Fitted fit={device.label} cx={device.x + device.w / 2} cy={rail.bodyY + BODY_PX / 2} className="sp-term-device-label" turned={device.label.rotated} />
        </g>
      ))}
      {rail.strips.map((strip) => {
        const selected = strip.stripId === selectedStripId;
        const own = rail.items.filter((entry) => entry.item.stripId === strip.stripId);
        const x = xOf(strip.offsetMm);
        const w = strip.extentMm * PX_PER_MM;
        return (
          <g
            key={strip.stripId}
            className={`sp-term-strip${selected ? " is-selected" : ""}${dragging === strip.stripId ? " is-dragging" : ""}`}
            data-strip={strip.stripId}
            data-drag-device={readOnly || !props.onMoveStrip ? undefined : strip.stripId}
          >
            <rect
              className="sp-term-strip-hit"
              x={x}
              y={rail.markerY}
              width={w}
              height={rail.bottom - rail.markerY}
              role="button"
              tabIndex={0}
              aria-label={`Klemmleiste ${strip.xLabel}`}
              aria-pressed={selected}
              onClick={() => onSelectStrip(strip.stripId)}
              onKeyDown={(event) => activateOnKey(event, () => onSelectStrip(strip.stripId))}
            />
            {own.map((entry) => (
              <Item key={entry.key} entry={entry} rail={rail} selected={entry.key === selectedItemKey} onSelect={() => onSelectItem(entry.key, strip.stripId)} />
            ))}
            {selected ? <rect className="sp-term-strip-outline" x={x - 2} y={rail.markerY - 2} width={w + 4} height={MARKER_ZONE_PX + BODY_PX + 4} /> : null}
          </g>
        );
      })}
      {plates.map((entry) => (
        <Item key={entry.key} entry={entry} rail={rail} selected={false} onSelect={() => undefined} />
      ))}
    </g>
  );
}

interface DragState {
  stripId: string;
  xLabel: string;
  /** The finger, client px: where the ghost and the label float. */
  client: Point;
  drop: StripDrop | null;
}

/** The rail under a y (px in the drawing): the block it lies in, else the nearest. */
function railAt(layout: CloseupLayout, y: number): RailLayout | null {
  const inside = layout.rails.find((rail) => y >= rail.top - RAIL_GAP_PX / 2 && y <= rail.bottom + RAIL_GAP_PX / 2);
  if (inside) return inside;
  if (layout.rails.length === 0) return null;
  return y < layout.rails[0].top ? layout.rails[0] : layout.rails[layout.rails.length - 1];
}

export function TerminalCloseupSvg(props: Props) {
  const { closeup, layout, readOnly, onMoveStrip, measure } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  // The strip in hand, for the release: state may lag a frame behind the pointer.
  const active = useRef<string | null>(null);

  const locate = (stripId: string, point: Point): StripDrop | null => {
    const box = svgRef.current?.getBoundingClientRect();
    const rail = box ? railAt(layout, point.y - box.top) : null;
    if (!box || !rail) return null;
    const strips = rail.strips.map((strip) => ({ id: strip.stripId, x: strip.offsetMm, w: strip.extentMm }));
    const slot = stripSlot(strips, stripId, (point.x - box.left - PAD_PX) / PX_PER_MM, rail.devicesEndMm);
    const overMm = measure?.(stripId, rail.position, slot.at) ?? 0;
    return {
      field: closeup.field, rail: rail.position, moduleId: rail.rail.moduleId, railKey: rail.rail.railKey, ...slot,
      overMm, refused: overMm > 0 ? "too_full" : null, bandBoxId: "", title: rail.rail.title,
    };
  };
  const xLabelOf = (stripId: string) => layout.rails.flatMap((rail) => rail.strips).find((strip) => strip.stripId === stripId)?.xLabel ?? "";

  useLongPressDrag({
    scrollRef,
    enabled: !readOnly && !!onMoveStrip,
    onStart: (stripId, point) => {
      active.current = stripId;
      setDrag({ stripId, xLabel: xLabelOf(stripId), client: point, drop: locate(stripId, point) });
    },
    onMove: (point) => setDrag((current) => (current ? { ...current, client: point, drop: locate(current.stripId, point) } : current)),
    onDrop: (point) => {
      const stripId = active.current;
      active.current = null;
      setDrag(null);
      if (!stripId) return;
      const drop = locate(stripId, point);
      if (drop && !drop.refused) onMoveStrip?.(stripId, { field: closeup.field, rail: drop.rail, at: drop.at });
    },
    onCancel: () => {
      active.current = null;
      setDrag(null);
    },
    // A slow (gloved) tap is still a tap (R9): on a terminal it selects that terminal, as a quick one does.
    onTap: (stripId, target) => {
      const key = target?.closest("[data-item]")?.getAttribute("data-item");
      if (key) props.onSelectItem(key, stripId);
      else props.onSelectStrip(stripId);
    },
  });

  const drop = drag?.drop ?? null;
  const target = drop ? layout.rails.find((rail) => rail.position === drop.rail) ?? null : null;
  const label = drag ? stripLabelText(drag.xLabel, closeup.field, drop) : "";
  return (
    <>
      <p className="sp-term-drag-label visually-hidden" aria-live="polite">
        {label}
      </p>
      {drag ? createPortal(<DragOverlay label={label} ghost={drag.xLabel} client={drag.client} drop={drop} />, document.body) : null}
      <div className="sp-term-scroll" ref={scrollRef}>
        <svg
          ref={svgRef}
          className="sp-term-svg"
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="group"
          aria-label={`Hutschienen mit Reihenklemmen, Feld ${closeup.field + 1}`}
        >
          {layout.rails.map((rail) => (
            <Rail key={`${rail.rail.moduleId}:${rail.rail.railKey}`} rail={rail} props={props} dragging={drag?.stripId ?? null} />
          ))}
          {drop && target ? (
            <rect
              className={`sp-term-drop-bar${drop.refused ? " is-refused" : ""}`}
              x={xOf(drop.indicatorX) - BAR_PX / 2}
              y={target.markerY}
              width={BAR_PX}
              height={MARKER_ZONE_PX + BODY_PX}
            />
          ) : null}
        </svg>
      </div>
    </>
  );
}
