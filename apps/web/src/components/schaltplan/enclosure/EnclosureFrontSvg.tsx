/**
 * The cabinet front, to scale, as the installer's working view
 * (docs/PANEL_ENCLOSURE.md §4, §11): open (modules, zones, rails with their
 * devices, meter places, gaps) or closed (covers, device fronts in their
 * slots, meter windows, blind plates, seal marks, door leaves).
 *
 * ONE tap rule at every zoom (D16): a tap anywhere in a rail band opens
 * that rail — RailSheet's 56 px tiles — with the tapped device highlighted;
 * a tap on a module's background opens the module; a tap on a free unit
 * picks that unit for a new module. A 1-TE breaker is 3.5 px wide at the
 * smallest step, so the drawing never asks for precision a gloved finger
 * does not have, and there is no "+" in it: RailSheet and the field bar
 * carry the add buttons.
 *
 * Two layers: the picture (aria-hidden, no pointer events) and, on top,
 * transparent targets that are the accessible content — `role="button"`,
 * an aria-label, Enter/Space. Rails, modules and free units are tab stops;
 * devices are reachable by pointer and screen reader but not tab stops (a
 * full ZB55S has hundreds), and the rail's RailSheet reaches each one.
 *
 * Zoom is stepped (buttons in the toolbar) and the drawing scrolls natively
 * in `.sp-encl-scroll`; a zoom step keeps the visible centre in place.
 * `readOnly` draws the picture only (the catalogue admin's preview). Without
 * `onPickSlot` (a board the viewer may not edit) free units are no targets
 * at all — no tab stop, no press tint, no "Modul wählen" that does nothing —
 * while rails and modules still open their sheets to read.
 *
 * The hit layer's order is load-bearing: in an SVG the shape painted last
 * takes the tap, so devices come after rail bands, and bands after free
 * units and module backgrounds (enclosureFrontSvg.test.tsx keeps it).
 *
 * Device drag (docs/PANEL_ENCLOSURE_R2.md §6, owner 2026-10-22): in the
 * Offen view of an editable board, with `onMoveDevice` and `dragSource`,
 * every device target is a drag source — long-press then move with a
 * finger or pen, or drag with the mouse (`useLongPressDrag`). A tap, short
 * or slow, still opens RailSheet as above. While dragging, nothing here
 * re-renders: the finger's position goes into a store that only
 * `EnclosureDragLayer` reads, and boxes are memoised.
 *
 * WAGO terminals (R2 §8, §7.2): placed strips are drawn on their terminal
 * rail; with `onOpenTerminals` a tap on a reserved rail's band, or on a
 * strip, opens the field's close-up (a device on a reserved rail still opens
 * RailSheet). With `onMoveStrip` and `stripSource` a strip drags as a whole
 * onto its own field's terminal rails (`useDrawingDrag`). Strip targets lie
 * above the bands and below the devices.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, type KeyboardEvent, type RefObject } from "react";

import type { EnclosureScene, SceneBox, TerminalPlacement } from "../../../types/panelEnclosure";
import { BoxShape, FieldHeader, GapShape, HatchPattern, ModuleLabel, isDrawn, type ShapeState } from "./EnclosureFrontBoxes";
import { reservedRailLine } from "./enclosureEditorModel";
import { EnclosureDragLayer } from "./EnclosureDragLayer";
import type { DeviceDragSource, DeviceDrop, StripDragSource, StripDrop } from "./enclosureDropTargets";
import { STRIP_BOX_PREFIX, useDrawingDrag } from "./useDrawingDrag";
import {
  DEFAULT_UNIT_MM,
  DRAWING_PAD_PX,
  FIELD_HEADER_PX,
  drawingSizePx,
  fieldIndexAt,
  freeCells,
  gapRuns,
  railBands,
  scrollForZoom,
  type FreeCell,
  type RailBand,
} from "./enclosureFrontLayout";
import "../../../styles/schaltplan-enclosure.css";

export interface EnclosureFrontSvgProps {
  scene: EnclosureScene;
  /** Screen px per mm, one of ENCLOSURE_ZOOM_STEPS. */
  zoom: number;
  highlightDeviceId: string | null;
  selectedModuleId: string | null;
  /** A tap in a rail band; `deviceId` is the tapped device, null beside the devices. */
  onOpenRail?: (moduleId: string, railKey: string, deviceId: string | null) => void;
  /** A tap on a module's background (zones and meter places included). */
  onOpenModule?: (moduleId: string) => void;
  /** A tap on a free unit: the 0-based field and unit the picker should place at. */
  onPickSlot?: (field: number, unit: number) => void;
  /** Picture only: no targets, no tab stops (the admin preview). */
  readOnly: boolean;
  /** The rail whose RailSheet is open, drawn active. */
  activeRail?: { moduleId: string; railKey: string } | null;
  /** The cabinet's raster (`EnclosureSpec.unit_mm`); the scene does not carry it. */
  unitMm?: number;
  /**
   * Called with the scroll container's inner width on mount and whenever the
   * cabinet width changes — feed it to `initialZoomStep`. Never on zoom.
   */
  onFitWidth?: (availablePx: number) => void;
  /** A device dropped by drag (Offen view, editable boards): the dragged device and where it lands. */
  onMoveDevice?: (deviceId: string, drop: DeviceDrop) => void;
  /** What dragging a device needs from the board, asked when a drag starts. Devices are drag sources only with this and `onMoveDevice`. */
  dragSource?: (deviceId: string) => DeviceDragSource | null;
  /** Rails reserved for WAGO terminals (`reservedRailKey`): a device drop there is refused, a tap opens the close-up. */
  reservedRails?: ReadonlySet<string>;
  /** The board's terminal placement: where a dragged strip may go. */
  placement?: TerminalPlacement | null;
  /** A tap on a reserved rail's band (`stripId` null) or on a strip: the field's close-up. */
  onOpenTerminals?: (field: number, stripId: string | null) => void;
  /** A strip dropped by drag (Offen view, editable boards): which strip and where it lands. */
  onMoveStrip?: (stripId: string, drop: StripDrop) => void;
  /** What dragging a strip needs, asked when a drag starts. Strips are drag sources only with this and `onMoveStrip`. */
  stripSource?: (stripId: string) => StripDragSource | null;
}

const NO_RAILS: ReadonlySet<string> = new Set();

const VIEW_WORD = { open: "offen", closed: "geschlossen" } as const;

function plural(count: number): string {
  if (count === 0) return "leer";
  return count === 1 ? "1 Gerät" : `${count} Geräte`;
}

// ── Targets ──────────────────────────────────────────────────────────────────

function activateOnKey(event: KeyboardEvent<SVGElement>, activate: () => void) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  activate();
}

function Target({ rect, label, kind, focusable, onActivate, data }: {
  rect: { x: number; y: number; w: number; h: number };
  label: string;
  kind: "module" | "slot" | "rail" | "strip" | "device";
  focusable: boolean;
  onActivate: () => void;
  data?: Record<string, string | number>;
}) {
  return (
    <rect
      className={`sp-encl-hit sp-encl-hit--${kind}`}
      x={rect.x}
      y={rect.y}
      width={Math.max(0, rect.w)}
      height={Math.max(0, rect.h)}
      role="button"
      tabIndex={focusable ? 0 : -1}
      aria-label={label}
      data-target={kind}
      onClick={onActivate}
      onKeyDown={(event) => activateOnKey(event, onActivate)}
      {...Object.fromEntries(Object.entries(data ?? {}).map(([key, value]) => [`data-${key}`, value]))}
    />
  );
}

function deviceTargetLabel(box: SceneBox, railLabel: string): string {
  const parts = [`Gerät ${box.label} auf ${railLabel}`];
  if (box.flags.includes("supplied")) parts.push("vorbestückt");
  if (box.flags.includes("overflow")) parts.push("passt nicht auf die Hutschiene");
  return parts.join(" · ");
}

function moduleTargetLabel(scene: EnclosureScene, box: SceneBox): string {
  const field = fieldIndexAt(scene, box.x + 1);
  return field === null ? `Modul ${box.label}` : `Modul ${box.label} in Feld ${field + 1}`;
}

interface HitProps {
  scene: EnclosureScene;
  cells: FreeCell[];
  bands: RailBand[];
  /** Devices carry `data-drag-device` (drag sources). */
  draggable: boolean;
  /** Strips carry `data-drag-device` (their box id). */
  stripsDraggable: boolean;
  onOpenRail: EnclosureFrontSvgProps["onOpenRail"];
  onOpenModule: EnclosureFrontSvgProps["onOpenModule"];
  onPickSlot: EnclosureFrontSvgProps["onPickSlot"];
  onOpenTerminals: EnclosureFrontSvgProps["onOpenTerminals"];
  /** The X labels the placement puts on each terminal rail, by `moduleId\u0000railKey`. */
  railStrips: ReadonlyMap<string, readonly string[]>;
}

/**
 * A reserved band names its strips ("· X1, X2" / "· noch keine"), then any
 * devices left there from before round 2; it is never "leer" while it holds
 * terminals. Every other band counts its devices.
 */
function bandLabel(band: RailBand, xLabels: readonly string[]): string {
  if (!band.reserved) return `Hutschiene ${band.label} · ${plural(band.deviceCount)}`;
  const devices = band.deviceCount > 0 ? ` · ${plural(band.deviceCount)}` : "";
  return `Hutschiene ${band.label} · ${reservedRailLine(xLabels)}${devices}`;
}

/** Placed strips per rail, left → right (open and closed view alike: the closed view only hides them). */
function stripsByRail(placement: TerminalPlacement | null): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>();
  for (const rail of placement?.fields.flatMap((field) => field.rails) ?? []) {
    out.set(`${rail.moduleId}\u0000${rail.railKey}`, rail.strips.map((strip) => strip.xLabel));
  }
  return out;
}

/** Bottom → top: module backgrounds, free units, rail bands, strips, devices — the most specific target wins. */
function HitLayer({ scene, cells, bands, draggable, stripsDraggable, onOpenRail, onOpenModule, onPickSlot, onOpenTerminals, railStrips }: HitProps) {
  const railLabels = new Map(bands.map((band) => [`${band.moduleId}\u0000${band.railKey}`, band.label]));
  const modules = scene.boxes.filter((box) => box.kind === "module" && box.moduleId !== null);
  const devices = scene.boxes.filter((box) => (box.kind === "device" || box.kind === "device_front") && box.deviceId && box.moduleId && box.railKey);
  const strips = onOpenTerminals ? scene.boxes.filter((box) => box.kind === "terminal_strip" && box.moduleId && box.railKey) : [];
  const openBand = (band: RailBand) =>
    band.reserved && onOpenTerminals && band.field !== null ? onOpenTerminals(band.field, null) : onOpenRail?.(band.moduleId, band.railKey, null);
  return (
    <g className="sp-encl-hits">
      {modules.map((box, i) => (
        <Target
          key={`${box.id}#${i}`}
          rect={box}
          kind="module"
          focusable
          label={moduleTargetLabel(scene, box)}
          onActivate={() => onOpenModule?.(box.moduleId as string)}
          data={{ "module-id": box.moduleId as string }}
        />
      ))}
      {(onPickSlot ? cells : []).map((cell) => (
        <Target
          key={`slot:${cell.field}:${cell.unit}`}
          rect={cell}
          kind="slot"
          focusable
          label={`Freier Platz in Feld ${cell.field + 1}, Höhe ${cell.unit + 1} von ${cell.units} — Modul wählen`}
          onActivate={() => onPickSlot?.(cell.field, cell.unit)}
          data={{ field: cell.field, unit: cell.unit }}
        />
      ))}
      {bands.map((band, i) => (
        <Target
          key={`${band.boxId}#${i}`}
          rect={band}
          kind="rail"
          focusable
          label={bandLabel(band, railStrips.get(`${band.moduleId}\u0000${band.railKey}`) ?? [])}
          onActivate={() => openBand(band)}
          data={{ "module-id": band.moduleId, "rail-key": band.railKey }}
        />
      ))}
      {strips.map((box, i) => {
        const field = fieldIndexAt(scene, box.x + box.w / 2);
        const stripId = box.id.slice(STRIP_BOX_PREFIX.length);
        return (
          <Target
            key={`${box.id}#${i}`}
            rect={box}
            kind="strip"
            focusable={false}
            label={`Klemmleiste ${box.label} auf ${railLabels.get(`${box.moduleId}\u0000${box.railKey}`) ?? ""}`}
            onActivate={() => field !== null && onOpenTerminals?.(field, stripId)}
            data={stripsDraggable ? { "strip-id": stripId, "drag-device": box.id } : { "strip-id": stripId }}
          />
        );
      })}
      {devices.map((box, i) => (
        <Target
          key={`${box.id}#${i}`}
          rect={box}
          kind="device"
          focusable={false}
          label={deviceTargetLabel(box, railLabels.get(`${box.moduleId}\u0000${box.railKey}`) ?? "")}
          onActivate={() => onOpenRail?.(box.moduleId as string, box.railKey as string, box.deviceId)}
          data={draggable ? { "device-id": box.deviceId as string, "drag-device": box.deviceId as string } : { "device-id": box.deviceId as string }}
        />
      ))}
    </g>
  );
}

// ── Scroll behaviour ─────────────────────────────────────────────────────────

interface Centre {
  x: number;
  y: number;
  /** Scrolled away from the top-left corner at all. */
  moved: boolean;
}

function centreOf(element: HTMLElement): Centre {
  return {
    x: element.scrollWidth > 0 ? (element.scrollLeft + element.clientWidth / 2) / element.scrollWidth : 0.5,
    y: element.scrollHeight > 0 ? (element.scrollTop + element.clientHeight / 2) / element.scrollHeight : 0.5,
    moved: element.scrollLeft > 0 || element.scrollTop > 0,
  };
}

/**
 * Keep the point in the middle of the viewport where it was when the zoom
 * steps. Unscrolled, the top-left corner stays put instead: that is the
 * initial fit, and the meter field the installer reads first.
 */
function useZoomAnchor(ref: RefObject<HTMLDivElement>, zoom: number, size: { width: number; height: number }) {
  const centre = useRef<Centre | null>(null);
  const previousZoom = useRef(zoom);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (previousZoom.current !== zoom && centre.current?.moved) {
      element.scrollLeft = scrollForZoom(centre.current.x, size.width, element.clientWidth);
      element.scrollTop = scrollForZoom(centre.current.y, size.height, element.clientHeight);
    }
    previousZoom.current = zoom;
    centre.current = centreOf(element);
    // Keyed on zoom alone: size follows it, and the centre is re-read on every scroll.
  }, [zoom]);
  return () => {
    if (ref.current) centre.current = centreOf(ref.current);
  };
}

function useScrollToDevice(ref: RefObject<HTMLDivElement>, deviceId: string | null) {
  useEffect(() => {
    if (!deviceId || !ref.current) return;
    const target = Array.from(ref.current.querySelectorAll<SVGGElement>(".sp-encl-picture [data-device-id]")).find(
      (element) => element.getAttribute("data-device-id") === deviceId,
    );
    target?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [ref, deviceId]);
}

// ── Drawing ──────────────────────────────────────────────────────────────────

export function EnclosureFrontSvg({
  scene,
  zoom,
  highlightDeviceId,
  selectedModuleId,
  onOpenRail,
  onOpenModule,
  onPickSlot,
  readOnly,
  activeRail = null,
  unitMm = DEFAULT_UNIT_MM,
  onFitWidth,
  onMoveDevice,
  dragSource,
  reservedRails = NO_RAILS,
  placement = null,
  onOpenTerminals,
  onMoveStrip,
  stripSource,
}: EnclosureFrontSvgProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const patternId = `sp-encl-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const cells = useMemo(() => freeCells(scene, unitMm), [scene, unitMm]);
  const gaps = useMemo(() => gapRuns(cells), [cells]);
  const bands = useMemo(() => railBands(scene, reservedRails), [scene, reservedRails]);
  const railStrips = useMemo(() => stripsByRail(placement), [placement]);
  const emptyRails = useMemo(() => {
    // A rail with strips is not empty: its label would lie under them.
    const withStrips = new Set(scene.boxes.filter((box) => box.kind === "terminal_strip").map((box) => `rail:${box.moduleId}:${box.railKey}`));
    return new Set(bands.filter((band) => band.deviceCount === 0 && !withStrips.has(band.boxId)).map((band) => band.boxId));
  }, [bands, scene]);
  const size = drawingSizePx(scene, zoom);
  const rememberCentre = useZoomAnchor(scrollRef, zoom, size);
  useScrollToDevice(scrollRef, highlightDeviceId);
  useLayoutEffect(() => {
    if (onFitWidth && scrollRef.current) onFitWidth(scrollRef.current.clientWidth);
    // Keyed on the cabinet width alone: a zoom step or a new callback identity must not re-fit.
  }, [scene.width]);
  const draggable = !readOnly && scene.view === "open" && !!onMoveDevice && !!dragSource;
  const stripsDraggable = !readOnly && scene.view === "open" && !!onMoveStrip && !!stripSource && !!placement && !!onOpenTerminals;
  const dragStore = useDrawingDrag({
    scrollRef, svgRef, scene, zoom, bands, enabled: draggable || stripsDraggable, reserved: reservedRails, placement,
    dragSource: draggable ? dragSource : undefined, onMoveDevice, stripSource: stripsDraggable ? stripSource : undefined, onMoveStrip, onOpenRail, onOpenTerminals,
  });

  const state: ShapeState = useMemo(
    () => ({ zoom, patternId, highlightDeviceId, selectedModuleId, activeRail, emptyRails }),
    [zoom, patternId, highlightDeviceId, selectedModuleId, activeRail, emptyRails],
  );
  const drawn = scene.boxes.filter((box) => isDrawn(box, scene.view));
  const back = drawn.filter((box) => box.kind === "shell" || box.kind === "field");
  const front = drawn.filter((box) => box.kind !== "shell" && box.kind !== "field");
  const pad = DRAWING_PAD_PX / zoom;
  const head = FIELD_HEADER_PX / zoom;
  const name = `Schrank ${scene.width} × ${scene.height} mm, ${VIEW_WORD[scene.view]}`;

  return (
    <div className="sp-encl-scroll" ref={scrollRef} onScroll={rememberCentre}>
      <svg
        ref={svgRef}
        className={`sp-encl-svg sp-encl-svg--${scene.view}${readOnly ? " sp-encl-svg--readonly" : ""}${draggable ? " sp-encl-svg--draggable" : ""}`}
        width={size.width}
        height={size.height}
        viewBox={`${-pad} ${-(head + pad)} ${scene.width + 2 * pad} ${scene.height + head + 2 * pad}`}
        role={readOnly ? "img" : "group"}
        aria-label={name}
      >
        <defs>
          <HatchPattern id={patternId} zoom={zoom} />
        </defs>
        <g className="sp-encl-picture" aria-hidden="true">
          {back.map((box, i) => <BoxShape key={`${box.id}#${i}`} box={box} state={state} />)}
          {back.filter((box) => box.kind === "field").map((box, i) => <FieldHeader key={`head:${box.id}#${i}`} box={box} zoom={zoom} />)}
          {gaps.map((run) => <GapShape key={`gap:${run.field}:${run.unit}`} run={run} state={state} />)}
          {front.map((box, i) => <BoxShape key={`${box.id}#${i}`} box={box} state={state} />)}
          {front.filter((box) => box.kind === "module").map((box, i) => <ModuleLabel key={`label:${box.id}#${i}`} box={box} zoom={zoom} />)}
        </g>
        {!readOnly && (
          <HitLayer
            scene={scene}
            cells={cells}
            bands={bands}
            draggable={draggable}
            stripsDraggable={stripsDraggable}
            onOpenRail={onOpenRail}
            onOpenModule={onOpenModule}
            onPickSlot={onPickSlot}
            onOpenTerminals={onOpenTerminals}
            railStrips={railStrips}
          />
        )}
        {draggable || stripsDraggable ? <EnclosureDragLayer store={dragStore} scene={scene} bands={bands} zoom={zoom} /> : null}
      </svg>
    </div>
  );
}
