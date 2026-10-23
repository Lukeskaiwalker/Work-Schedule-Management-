/**
 * The drags of the 2D cabinet drawing (docs/PANEL_ENCLOSURE_R2.md §6, §7.2,
 * R9, R11): a device (a group head with its circuits) onto any rail, and a
 * whole WAGO strip onto its own field's terminal rails. ONE long-press hook
 * per scroll container — two would both start on one press — so the source
 * decides: a `data-drag-device` naming a strip box (`terminal:{stripId}`)
 * drags that strip, anything else the device of that id.
 *
 * The drop index is built once when the drag starts; every frame turns the
 * finger into a drop in the drag store (never React state here); a release
 * that the rail takes hands the drop on. A long press released in place is
 * a tap: the device's RailSheet, or the strip's close-up.
 */
import { useRef, useState, type RefObject } from "react";

import { createDragStore, type DragStore } from "./EnclosureDragLayer";
import {
  buildDropIndex,
  clientToSceneMm,
  deviceDropAt,
  stripDropAt,
  stripLabelText,
  type DeviceDragSource,
  type DeviceDrop,
  type DropIndex,
  type StripDragSource,
  type StripDrop,
} from "./enclosureDropTargets";
import { fieldIndexAt, type RailBand } from "./enclosureFrontLayout";
import type { Point } from "./dragMachine";
import { useLongPressDrag } from "./useLongPressDrag";
import type { EnclosureScene, TerminalPlacement } from "../../../types/panelEnclosure";

/** The box id of a strip in the scene, and the `data-drag-device` its target carries. */
export const STRIP_BOX_PREFIX = "terminal:";

export interface DrawingDragArgs {
  scrollRef: RefObject<HTMLDivElement>;
  svgRef: RefObject<SVGSVGElement>;
  scene: EnclosureScene;
  zoom: number;
  bands: RailBand[];
  enabled: boolean;
  reserved: ReadonlySet<string>;
  placement: TerminalPlacement | null;
  dragSource?: (deviceId: string) => DeviceDragSource | null;
  onMoveDevice?: (deviceId: string, drop: DeviceDrop) => void;
  stripSource?: (stripId: string) => StripDragSource | null;
  onMoveStrip?: (stripId: string, drop: StripDrop) => void;
  onOpenRail?: (moduleId: string, railKey: string, deviceId: string | null) => void;
  onOpenTerminals?: (field: number, stripId: string | null) => void;
}

type Active =
  | { kind: "device"; deviceId: string; source: DeviceDragSource; index: DropIndex }
  | { kind: "strip"; boxId: string; source: StripDragSource; index: DropIndex };

/** A strip drop as the drag layer draws it (band, bar, refusal). */
function asDeviceDrop(drop: StripDrop): DeviceDrop {
  return {
    moduleId: drop.moduleId, railKey: drop.railKey, rowId: null, at: drop.at, indicatorX: drop.indicatorX,
    bandBoxId: drop.bandBoxId, title: drop.title, afterLabel: null, overMm: drop.overMm, refused: drop.refused,
  };
}

const isStripBox = (scene: EnclosureScene, id: string): boolean =>
  id.startsWith(STRIP_BOX_PREFIX) && scene.boxes.some((box) => box.kind === "terminal_strip" && box.id === id) &&
  !scene.boxes.some((box) => box.kind === "device" && box.deviceId === id);

export function useDrawingDrag(args: DrawingDragArgs): DragStore {
  const [store] = useState(createDragStore);
  const active = useRef<Active | null>(null);
  const sceneMm = (point: Point) => {
    const svg = args.svgRef.current;
    return svg ? clientToSceneMm(svg.getBoundingClientRect(), args.zoom, point) : null;
  };
  const deviceDrop = (drag: Extract<Active, { kind: "device" }>, point: Point) => {
    const mm = sceneMm(point);
    return mm ? deviceDropAt(drag.index, mm, drag.source.deviceIds) : null;
  };
  const stripDrop = (drag: Extract<Active, { kind: "strip" }>, point: Point) => {
    const mm = sceneMm(point);
    return mm && args.placement ? stripDropAt(drag.index, args.placement, mm, drag.source.stripId, drag.source.overMmOn) : null;
  };
  const show = (point: Point) => {
    const drag = active.current;
    if (!drag) return;
    if (drag.kind === "device") {
      store.set({ deviceIds: drag.source.deviceIds, name: drag.source.name, ghost: drag.source.ghost, client: point, drop: deviceDrop(drag, point) });
      return;
    }
    const drop = stripDrop(drag, point);
    store.set({
      deviceIds: [], boxIds: [drag.boxId], name: drag.source.xLabel, ghost: drag.source.xLabel, client: point,
      drop: drop ? asDeviceDrop(drop) : null, text: stripLabelText(drag.source.xLabel, drag.source.field, drop),
    });
  };
  const end = () => {
    active.current = null;
    store.set(null);
  };
  const start = (sourceId: string): Active | null => {
    if (isStripBox(args.scene, sourceId)) {
      const source = args.stripSource?.(sourceId.slice(STRIP_BOX_PREFIX.length)) ?? null;
      return source ? { kind: "strip", boxId: sourceId, source, index: buildDropIndex(args.scene, args.bands, { reserved: args.reserved, rowsInOrder: true }) } : null;
    }
    const source = args.dragSource?.(sourceId) ?? null;
    if (!source) return null;
    const overMmOn = (band: RailBand) => source.overMmOn(band.moduleId, band.railKey);
    return { kind: "device", deviceId: sourceId, source, index: buildDropIndex(args.scene, args.bands, { reserved: args.reserved, rowsInOrder: source.rowsInOrder, overMmOn }) };
  };
  useLongPressDrag({
    scrollRef: args.scrollRef,
    enabled: args.enabled,
    onStart: (sourceId, point) => {
      active.current = start(sourceId);
      show(point);
    },
    onMove: show,
    onDrop: (point) => {
      const drag = active.current;
      end();
      if (drag?.kind === "device") {
        const drop = deviceDrop(drag, point);
        if (drop && !drop.refused) args.onMoveDevice?.(drag.deviceId, drop);
      } else if (drag?.kind === "strip") {
        const drop = stripDrop(drag, point);
        if (drop && !drop.refused) args.onMoveStrip?.(drag.source.stripId, drop);
      }
    },
    onCancel: end,
    onTap: (sourceId) => {
      if (isStripBox(args.scene, sourceId)) {
        const box = args.scene.boxes.find((candidate) => candidate.id === sourceId)!;
        const field = fieldIndexAt(args.scene, box.x + box.w / 2);
        if (field !== null) args.onOpenTerminals?.(field, sourceId.slice(STRIP_BOX_PREFIX.length));
        return;
      }
      const box = args.scene.boxes.find((candidate) => candidate.kind === "device" && candidate.deviceId === sourceId);
      if (box?.moduleId && box.railKey) args.onOpenRail?.(box.moduleId, box.railKey, sourceId);
    },
  });
  return store;
}
