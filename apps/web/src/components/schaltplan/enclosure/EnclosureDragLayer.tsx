/**
 * What a device drag shows (docs/PANEL_ENCLOSURE_R2.md §6.6, §6.7).
 *
 * The drag never re-renders the drawing: pointer moves go into a tiny
 * external store (`createDragStore`), and only this layer subscribes. It
 * is a sibling `<g>` above the hit layer (no pointer events) plus a portal:
 *
 *  - in the SVG: the dragged devices dimmed by overlay rects (the device
 *    pictures themselves never re-render), the target band tinted
 *    (`is-drop-target`, or `is-refused`), and an insertion bar of constant
 *    screen width;
 *  - in a fixed-position portal (never clipped by the scroller): a ghost of
 *    at least 44 × 44 px with the BMK, centred 56 px above the finger — a
 *    gloved contact patch covers several breakers at 0.45 px/mm — and the
 *    label `{bmk} {short} → {title} · nach {bmk}`, shown from the moment
 *    the press arms, so a wrong pick can be released in place;
 *  - a polite live echo whose text changes only when the rail, the place
 *    or the refusal does, not on every pixel.
 */
import { useMemo, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { dropLabelText, type DeviceDrop } from "./enclosureDropTargets";
import type { RailBand } from "./enclosureFrontLayout";
import type { EnclosureScene } from "../../../types/panelEnclosure";
import "../../../styles/schaltplan-enclosure-drag.css";

/** The ghost's smallest side and its lift above the finger, CSS px. */
export const GHOST_MIN_PX = 44;
export const GHOST_OFFSET_PX = 56;
/** The insertion bar's width on screen at every zoom. */
const BAR_PX = 3;
/** Gap between the ghost and the label above it; below this top the label goes under the finger. */
const LABEL_GAP_PX = 8;
const LABEL_MIN_TOP_PX = 64;

export interface DragView {
  /** The travelling devices (a head with its circuits), dimmed in the drawing. */
  deviceIds: readonly string[];
  /** Other boxes dimmed (a dragged WAGO strip, R2 §8). */
  boxIds?: readonly string[];
  /** The label as the drag's own rule words it (a strip: `stripLabelText`); else `dropLabelText`. */
  text?: string;
  /** "F1.4 LS B16" — the label's source half. */
  name: string;
  /** The BMK on the ghost. */
  ghost: string;
  /** The finger, client px. */
  client: { x: number; y: number };
  drop: DeviceDrop | null;
}

export interface DragStore {
  get(): DragView | null;
  set(view: DragView | null): void;
  subscribe(listener: () => void): () => void;
}

export function createDragStore(): DragStore {
  let current: DragView | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(view) {
      if (view === current) return;
      current = view;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

type Props = { store: DragStore; scene: EnclosureScene; bands: readonly RailBand[]; zoom: number };

function echoKey(view: DragView | null): string {
  if (!view) return "";
  const drop = view.drop;
  return drop ? `${view.name}|${drop.moduleId}|${drop.railKey}|${drop.at}|${drop.refused ?? ""}` : `${view.name}|-`;
}

const labelOf = (view: DragView): string => view.text ?? dropLabelText(view.name, view.drop);

export interface DragOverlayProps {
  label: string;
  /** The text on the ghost: a BMK, or a strip's X label. */
  ghost: string;
  /** The finger, client px. */
  client: { x: number; y: number };
  drop: { refused: unknown; overMm: number } | null;
}

/**
 * The ghost and the label, fixed-position, for a portal on the page: never
 * clipped or scrolled away by a scroller or a sheet's body. Shared by the
 * cabinet drawing and the terminal close-up (§7.2).
 */
export function DragOverlay({ label, ghost, client, drop }: DragOverlayProps) {
  const ghostTop = client.y - GHOST_OFFSET_PX - GHOST_MIN_PX / 2;
  const above = ghostTop - LABEL_GAP_PX >= LABEL_MIN_TOP_PX;
  return (
    <>
      <div
        className="sp-encl-drag-ghost"
        aria-hidden="true"
        style={{ left: client.x - GHOST_MIN_PX / 2, top: ghostTop, minWidth: GHOST_MIN_PX, minHeight: GHOST_MIN_PX }}
      >
        {ghost}
      </div>
      <div
        className={`sp-encl-drag-label${drop?.refused ? " is-refused" : drop && drop.overMm > 0 ? " is-tight" : ""}`}
        aria-hidden="true"
        style={above ? { top: ghostTop - LABEL_GAP_PX, transform: "translateY(-100%)" } : { top: client.y + GHOST_MIN_PX }}
      >
        {label}
      </div>
    </>
  );
}

export function EnclosureDragLayer({ store, scene, bands, zoom }: Props) {
  const view = useSyncExternalStore(store.subscribe, store.get, store.get);
  const key = echoKey(view);
  // Keyed on (rail, place, refusal): the echo is not re-announced while the finger wanders on one spot.
  const echo = useMemo(() => (view ? labelOf(view) : ""), [key]);
  const sources = useMemo(() => {
    const ids = new Set(view?.deviceIds ?? []);
    const boxes = new Set(view?.boxIds ?? []);
    return scene.boxes.filter((box) => (box.kind === "device" && box.deviceId !== null && ids.has(box.deviceId)) || boxes.has(box.id));
  }, [scene, view?.deviceIds, view?.boxIds]);
  const drop = view?.drop ?? null;
  const band = drop ? bands.find((candidate) => candidate.boxId === drop.bandBoxId) ?? null : null;
  const barWidth = BAR_PX / zoom;

  return (
    <>
      <g className="sp-encl-drag-layer" aria-hidden="true">
        {sources.map((box) => (
          <rect key={box.id} className="sp-encl-drag-source" data-device-id={box.deviceId ?? undefined} x={box.x} y={box.y} width={box.w} height={box.h} />
        ))}
        {band ? (
          <rect
            className={`sp-encl-drop-band ${drop?.refused ? "is-refused" : "is-drop-target"}`}
            data-band={band.boxId}
            x={band.x}
            y={band.y}
            width={band.w}
            height={band.h}
          />
        ) : null}
        {band && drop && !drop.refused ? (
          <rect className="sp-encl-drop-bar" x={drop.indicatorX - barWidth / 2} y={band.y} width={barWidth} height={band.h} />
        ) : null}
      </g>
      {createPortal(
        <>
          {view ? <DragOverlay label={labelOf(view)} ghost={view.ghost} client={view.client} drop={view.drop} /> : null}
          <p className="sp-encl-drag-live visually-hidden" aria-live="polite">
            {echo}
          </p>
        </>,
        document.body,
      )}
    </>
  );
}
