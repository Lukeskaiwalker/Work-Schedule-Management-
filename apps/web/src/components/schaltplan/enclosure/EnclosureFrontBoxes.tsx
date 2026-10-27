/**
 * The visible layer of the 2D cabinet drawing: one shape per scene box
 * (docs/PANEL_ENCLOSURE.md §4), drawn in the scene's (z, y, x) order.
 *
 * Coordinates are cabinet mm (the SVG viewBox); text is sized in screen px
 * and converted with the zoom, so a label is the same size at every step
 * and the label rule (`fitBoxLabel`) can decide against real px. Nothing
 * here is interactive — the hit layer in `EnclosureFrontSvg` lies on top —
 * and nothing computes a position the geometry did not hand over.
 *
 * WAGO terminals (docs/PANEL_ENCLOSURE_R2.md §8): a placed strip is a
 * light-grey block with its X label; a rail reserved for terminals is tinted
 * and hatched (flag `terminals`), even when empty.
 *
 * Round 4 (docs/PANEL_ENCLOSURE_R4.md §5): the §14a block ("§14a", red when
 * it does not fit its rail). The leads are `EnclosureRuns`.
 *
 * The shapes draw bodies only; every label is a second pass (`BoxLabel`,
 * `GapLabel`, `ModuleLabel`) drawn after the boxes and the leads, so a lead
 * that ends on a rail or a meter runs under its label, never through it
 * (with `halo`, the label sits on a ground of the surface colour).
 */
import { memo, type ReactElement } from "react";

import type { SceneBox } from "../../../types/panelEnclosure";
import {
  DEVICE_FONT_PX,
  FIELD_FONT_PX,
  FIELD_HEADER_PX,
  SMALL_FONT_PX,
  fitBoxLabel,
  fitLineLabel,
  type FittedLabel,
  type GapRun,
} from "./enclosureFrontLayout";
import "../../../styles/schaltplan-enclosure-terminals.css";
import "../../../styles/schaltplan-enclosure-control.css";

/** Room left above a zone's first rail band for its label (U/2 − half a device), mm. */
export const ZONE_LABEL_STRIP_MM = 30;
/** Inset of corner labels and marks, px. */
export const INSET_PX = 4;
/** A label's halo over the leads, px. */
const LABEL_HALO_PX = 3;
const SEAL_RADIUS_PX = 4;
/** The meter number's fallback size before it would be cut. */
const METER_SMALL_FONT_PX = 8;

export interface ShapeState {
  zoom: number;
  /** Prefix of the `<pattern>` ids, unique per drawing. */
  patternId: string;
  highlightDeviceId: string | null;
  selectedModuleId: string | null;
  activeRail: { moduleId: string; railKey: string } | null;
  /** Rail box ids that hold no device: only those show their label (devices would cover it). */
  emptyRails: ReadonlySet<string>;
  /** Leads are drawn: the labels get a halo of the surface colour. */
  halo?: boolean;
}

function cls(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

function Rect({ box, className }: { box: { x: number; y: number; w: number; h: number }; className: string }) {
  return <rect className={className} x={box.x} y={box.y} width={Math.max(0, box.w)} height={Math.max(0, box.h)} />;
}

/** A fitted label, centred at (cx, cy) in mm; rotated labels read bottom → top. */
function Label({ fitted, cx, cy, zoom, className, labelFor, anchor = "middle", halo = false }: {
  fitted: FittedLabel;
  cx: number;
  cy: number;
  zoom: number;
  className: string;
  labelFor: string;
  anchor?: "start" | "middle" | "end";
  halo?: boolean;
}) {
  if (fitted.mode === "hidden") return null;
  return (
    <text
      className={cls(className, halo && "sp-encl-text--halo")}
      strokeWidth={halo ? LABEL_HALO_PX / zoom : undefined}
      data-label-for={labelFor}
      x={cx}
      y={cy}
      textAnchor={anchor}
      dominantBaseline="central"
      fontSize={fitted.fontPx / zoom}
      transform={fitted.mode === "rotated" ? `rotate(-90 ${cx} ${cy})` : undefined}
    >
      {fitted.text}
    </text>
  );
}

const centreX = (box: SceneBox) => box.x + box.w / 2;
const centreY = (box: SceneBox) => box.y + box.h / 2;

function boxLabel(box: SceneBox, state: ShapeState, className: string, fontPx = DEVICE_FONT_PX) {
  const fitted = fitBoxLabel(box.label, box.w * state.zoom, box.h * state.zoom, fontPx);
  return <Label fitted={fitted} cx={centreX(box)} cy={centreY(box)} zoom={state.zoom} className={className} labelFor={box.id} halo={state.halo} />;
}

// ── Per kind ─────────────────────────────────────────────────────────────────

function ModuleShape({ box, state }: { box: SceneBox; state: ShapeState }) {
  return (
    <g
      data-box-id={box.id}
      data-kind={box.kind}
      className={cls(
        "sp-encl-module",
        box.flags.includes("unknown_code") && "sp-encl-module--unknown",
        box.flags.includes("unverified") && "sp-encl-module--unverified",
        state.selectedModuleId === box.moduleId && "is-selected",
      )}
    >
      <Rect box={box} className="sp-encl-module-body" />
    </g>
  );
}

/**
 * The article number in a module's top-right corner, drawn after every
 * other box: the module's own zones (and, closed, its covers) lie on top of
 * the module body and would hide it.
 */
export function ModuleLabel({ box, zoom, halo = false }: { box: SceneBox; zoom: number; halo?: boolean }) {
  const unknown = box.flags.includes("unknown_code");
  const note = unknown ? "Code unbekannt" : box.flags.includes("unverified") ? "ungeprüft" : "";
  const fit = (text: string) => fitLineLabel(text, (box.w * zoom) / 2, ZONE_LABEL_STRIP_MM * zoom, SMALL_FONT_PX);
  // The note only when it fits whole; a cut "ungeprü…" reads worse than the article alone.
  const withNote = note ? fit(`${box.label} · ${note}`) : null;
  const fitted = withNote && withNote.text === `${box.label} · ${note}` ? withNote : fit(box.label);
  return (
    <Label
      fitted={fitted}
      cx={box.x + box.w - INSET_PX / zoom}
      cy={box.y + ZONE_LABEL_STRIP_MM / 2}
      zoom={zoom}
      className={cls("sp-encl-text sp-encl-text--module", unknown && "sp-encl-text--unknown")}
      labelFor={box.id}
      anchor="end"
      halo={halo}
    />
  );
}

function ZoneShape({ box }: { box: SceneBox }) {
  return (
    <g data-box-id={box.id} data-kind={box.kind} className={cls("sp-encl-zone", box.zoneType && `sp-encl-zone--${box.zoneType.toLowerCase()}`)}>
      <Rect box={box} className="sp-encl-zone-body" />
    </g>
  );
}

function zoneLabel(box: SceneBox, state: ShapeState) {
  const { zoom } = state;
  const fitted = fitLineLabel(box.label, (box.w * zoom) / 2, ZONE_LABEL_STRIP_MM * zoom, SMALL_FONT_PX);
  return (
    <Label fitted={fitted} cx={box.x + INSET_PX / zoom} cy={box.y + ZONE_LABEL_STRIP_MM / 2} zoom={zoom} className="sp-encl-text sp-encl-text--zone" labelFor={box.id} anchor="start" halo={state.halo} />
  );
}

function RailShape({ box, state }: { box: SceneBox; state: ShapeState }) {
  const busbar = box.kind === "busbar";
  const active = state.activeRail?.moduleId === box.moduleId && state.activeRail?.railKey === box.railKey;
  // A DIN rail's two folds; a busbar's five bars (5-polig).
  const lines = busbar ? [1, 2, 3, 4, 5].map((i) => box.y + (box.h * i) / 6) : [box.y + box.h * 0.28, box.y + box.h * 0.72];
  const terminals = box.flags.includes("terminals");
  return (
    <g
      data-box-id={box.id}
      data-kind={box.kind}
      className={cls(
        busbar ? "sp-encl-busbar" : "sp-encl-rail",
        box.flags.includes("retired") && "sp-encl-rail--retired",
        terminals && "sp-encl-rail--terminals",
        active && "is-active",
      )}
    >
      <Rect box={box} className="sp-encl-rail-body" />
      {terminals ? (
        <rect className="sp-encl-hatch sp-encl-terminal-hatch" x={box.x} y={box.y} width={box.w} height={box.h} fill={`url(#${state.patternId}-hatch)`} />
      ) : null}
      {lines.map((y) => (
        <line key={y} className="sp-encl-rail-line" x1={box.x} x2={box.x + box.w} y1={y} y2={y} />
      ))}
    </g>
  );
}

function DeviceShape({ box, state }: { box: SceneBox; state: ShapeState }) {
  const front = box.kind === "device_front";
  return (
    <g
      data-box-id={box.id}
      data-kind={box.kind}
      data-device-id={box.deviceId ?? undefined}
      className={cls(
        front ? "sp-encl-front" : "sp-encl-device",
        box.flags.includes("supplied") && "sp-encl-device--supplied",
        box.flags.includes("overflow") && "sp-encl-device--overflow",
        box.deviceId !== null && box.deviceId === state.highlightDeviceId && "is-highlight",
      )}
    >
      <Rect box={box} className="sp-encl-device-body" />
    </g>
  );
}

/** A placed WAGO strip (open view): its extent on the rail, the 2003-7641 body height, the X label. */
function TerminalStripShape({ box }: { box: SceneBox }) {
  return (
    <g data-box-id={box.id} data-kind={box.kind} className="sp-encl-strip">
      <Rect box={box} className="sp-encl-strip-body" />
    </g>
  );
}

/** The §14a block on its AAR rail (open view): grey like the terminals, outlined violet like its wires. */
function ControlBlockShape({ box }: { box: SceneBox }) {
  return (
    <g
      data-box-id={box.id}
      data-kind={box.kind}
      className={cls("sp-encl-control-block", box.flags.includes("overflow") && "sp-encl-control-block--overflow")}
    >
      <Rect box={box} className="sp-encl-control-block-body" />
    </g>
  );
}

/** An eHZ / 3-Punkt meter (open) or its front behind the window (closed): a display above the number. */
function MeterShape({ box }: { box: SceneBox }) {
  const display = { x: box.x + box.w * 0.15, y: box.y + box.h * 0.12, w: box.w * 0.7, h: box.h * 0.16 };
  return (
    <g data-box-id={box.id} data-kind={box.kind} className="sp-encl-meter">
      <Rect box={box} className="sp-encl-meter-body" />
      <Rect box={display} className="sp-encl-meter-display" />
    </g>
  );
}

function meterLabel(box: SceneBox, state: ShapeState) {
  const { zoom } = state;
  const lower = { ...box, y: box.y + box.h * 0.35, h: box.h * 0.6 };
  // A meter number is read off to the grid operator: a smaller font beats a cut one.
  const regular = fitBoxLabel(box.label, lower.w * zoom, lower.h * zoom, DEVICE_FONT_PX);
  const small = fitBoxLabel(box.label, lower.w * zoom, lower.h * zoom, METER_SMALL_FONT_PX);
  const fitted = regular.text === box.label.trim() || small.text !== box.label.trim() ? regular : small;
  return <Label fitted={fitted} cx={centreX(lower)} cy={centreY(lower)} zoom={zoom} className="sp-encl-text sp-encl-text--meter" labelFor={box.id} halo={state.halo} />;
}

function HatchedShape({ box, state, className }: { box: SceneBox; state: ShapeState; className: string }) {
  return (
    <g data-box-id={box.id} data-kind={box.kind} className={className}>
      <Rect box={box} className={`${className}-body`} />
      <rect className="sp-encl-hatch" x={box.x} y={box.y} width={box.w} height={box.h} fill={`url(#${state.patternId}-hatch)`} />
    </g>
  );
}

function CoverShape({ box, state }: { box: SceneBox; state: ShapeState }) {
  const r = SEAL_RADIUS_PX / state.zoom;
  const inset = (INSET_PX + SEAL_RADIUS_PX) / state.zoom;
  const seal = box.flags.includes("sealable") && box.w > 2 * inset && box.h > 2 * inset;
  return (
    <g data-box-id={box.id} data-kind={box.kind} className="sp-encl-cover">
      <Rect box={box} className="sp-encl-cover-body" />
      {seal && <circle className="sp-encl-seal" cx={box.x + box.w - inset} cy={box.y + inset} r={r} />}
    </g>
  );
}

function PlainShape({ box, className }: { box: SceneBox; className: string }) {
  return (
    <g data-box-id={box.id} data-kind={box.kind} className={className}>
      <Rect box={box} className={`${className}-body`} />
    </g>
  );
}

/** Kinds a view does not show: doors in the open view (§4), what the covers hide in the closed one. */
const SKIPPED: Readonly<Record<"open" | "closed", ReadonlySet<string>>> = {
  open: new Set(["door", "handle"]),
  closed: new Set(["zone", "rail", "busbar", "device", "meter", "meter_place", "terminal_strip", "control_block"]),
};

export function isDrawn(box: SceneBox, view: "open" | "closed"): boolean {
  return !SKIPPED[view].has(box.kind);
}

/**
 * One box. Memoised (R2 §6.7): with a memoised `ShapeState` a box re-draws
 * only when it or the drawing's state changes — not while a drag moves,
 * which only the drag layer follows.
 */
export const BoxShape = memo(function BoxShape({ box, state }: { box: SceneBox; state: ShapeState }): ReactElement | null {
  switch (box.kind) {
    case "shell":
      return <PlainShape box={box} className="sp-encl-shell" />;
    case "field":
      return <PlainShape box={box} className="sp-encl-field" />;
    case "module":
      return <ModuleShape box={box} state={state} />;
    case "zone":
      return <ZoneShape box={box} />;
    case "rail":
    case "busbar":
      return <RailShape box={box} state={state} />;
    case "device":
    case "device_front":
      return <DeviceShape box={box} state={state} />;
    case "terminal_strip":
      return <TerminalStripShape box={box} />;
    case "control_block":
      return <ControlBlockShape box={box} />;
    case "meter":
    case "meter_front":
      return <MeterShape box={box} />;
    case "meter_place":
      return <HatchedShape box={box} state={state} className="sp-encl-meter-place" />;
    case "blind_plate":
      return <HatchedShape box={box} state={state} className="sp-encl-blind" />;
    case "cover":
      return <CoverShape box={box} state={state} />;
    case "cover_slot":
      return <PlainShape box={box} className="sp-encl-slot" />;
    case "window":
      return <PlainShape box={box} className="sp-encl-window" />;
    case "door":
      return <PlainShape box={box} className="sp-encl-door" />;
    case "handle":
      return <PlainShape box={box} className="sp-encl-handle" />;
    default:
      return null;
  }
});

/**
 * The label of one box, drawn in the label pass after every box and lead.
 * Memoised like `BoxShape`. Rails show theirs only when empty (devices would cover it).
 */
export const BoxLabel = memo(function BoxLabel({ box, state }: { box: SceneBox; state: ShapeState }): ReactElement | null {
  switch (box.kind) {
    case "zone":
      return zoneLabel(box, state);
    case "rail":
    case "busbar":
      return state.emptyRails.has(box.id) ? boxLabel(box, state, "sp-encl-text sp-encl-text--rail", SMALL_FONT_PX) : null;
    case "device":
    case "device_front":
      return boxLabel(box, state, "sp-encl-text sp-encl-text--device");
    case "terminal_strip":
      return boxLabel(box, state, "sp-encl-text sp-encl-text--strip", SMALL_FONT_PX);
    case "control_block":
      return boxLabel(box, state, "sp-encl-text sp-encl-text--control", SMALL_FONT_PX);
    case "meter":
    case "meter_front":
      return meterLabel(box, state);
    case "meter_place":
      return boxLabel(box, state, "sp-encl-text sp-encl-text--free", SMALL_FONT_PX);
    case "blind_plate":
      return boxLabel(box, state, "sp-encl-text sp-encl-text--blind", SMALL_FONT_PX);
    default:
      return null;
  }
});

/** A stretch of free units: hatched; its "frei · {mm}" is `GapLabel`. */
export function GapShape({ run, state }: { run: GapRun; state: ShapeState }) {
  return (
    <g data-box-id={`gap:${run.field}:${run.unit}`} data-kind="gap" className="sp-encl-gap">
      <Rect box={run} className="sp-encl-gap-body" />
      <rect className="sp-encl-hatch" x={run.x} y={run.y} width={run.w} height={run.h} fill={`url(#${state.patternId}-hatch)`} />
    </g>
  );
}

export function GapLabel({ run, state }: { run: GapRun; state: ShapeState }) {
  const { zoom } = state;
  const fitted = fitLineLabel(`frei · ${Math.round(run.h)} mm`, run.w * zoom, run.h * zoom, SMALL_FONT_PX);
  return (
    <Label fitted={fitted} cx={run.x + run.w / 2} cy={run.y + run.h / 2} zoom={zoom} className="sp-encl-text sp-encl-text--gap" labelFor={`gap:${run.field}:${run.unit}`} halo={state.halo} />
  );
}

/** "Feld 1" … above the cabinet, in the header band (constant px at every zoom). */
export function FieldHeader({ box, zoom }: { box: SceneBox; zoom: number }) {
  const fitted = fitLineLabel(box.label, box.w * zoom, FIELD_HEADER_PX, FIELD_FONT_PX);
  return (
    <Label
      fitted={fitted}
      cx={box.x + box.w / 2}
      cy={-(FIELD_HEADER_PX / 2) / zoom}
      zoom={zoom}
      className="sp-encl-text sp-encl-text--field"
      labelFor={`head:${box.id}`}
    />
  );
}

/** The diagonal hatch of gaps, free meter places and blind plates: 8 px apart at every zoom. */
export function HatchPattern({ id, zoom }: { id: string; zoom: number }) {
  const size = 8 / zoom;
  return (
    <pattern id={`${id}-hatch`} patternUnits="userSpaceOnUse" width={size} height={size} patternTransform="rotate(45)">
      <line className="sp-encl-hatch-line" x1={0} y1={0} x2={0} y2={size} />
    </pattern>
  );
}
