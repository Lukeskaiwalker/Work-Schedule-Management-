/**
 * The long-press drag gesture of the Schrank drawing, as a pure state
 * machine (docs/PANEL_ENCLOSURE_R2.md §6.2, R9): idle → pressing → armed →
 * dragging → idle. `useLongPressDrag` feeds it pointer events and carries
 * out the effect each step names; nothing here touches the DOM, so every
 * rule is a plain unit test.
 *
 *   pointer      pressing → armed      cancels before arming      armed → dragging     release in armed
 *   touch / pen  LONG_PRESS_MS still   > SLOP_PX: native scroll   > SLOP_PX moved      tap (RailSheet)
 *   mouse        — (straight to drag)  release = ordinary click   > MOUSE_SLOP_PX      —
 *
 * A release while pressing is an ordinary click, so the one tap rule (D16)
 * holds; a slow gloved tap (held, never moved) is a tap too. Only a release
 * while dragging drops. A pointerdown of any other pointer aborts (a pinch,
 * a second finger); moves and releases of pointers that were already down
 * are ignored, so a thumb resting on the glass does not end the drag.
 *
 * The constants are the addendum's defaults, checked in the W0 spike
 * (2026-10-22, iPadOS 26.5 simulator, Mobile Safari, this hook on 30 SVG
 * rects in an overflow:auto scroller): a short tap stays a click, a 700 ms
 * still press arms at 450 ms and releases as one tap, a long press then a
 * move drags without the scroller or the page panning, a finger that moves
 * first scrolls natively, a two-finger pinch starts nothing, and holding at
 * the scroller's edge auto-scrolls. 8 px stays inside the browsers' own pan
 * slop, so no native pan has begun when the press arms. Not yet checked:
 * Android Chrome and a real iPad with work gloves (§14.4), which may adjust
 * the numbers.
 */

export const LONG_PRESS_MS = 450;
export const SLOP_PX = 8;
export const MOUSE_SLOP_PX = 6;
/**
 * The click a browser sends after a drop (or after a long-press tap already
 * handled) is swallowed: one click, this soon, this close to the release
 * point — a deliberate tap elsewhere (Rückgängig) is never eaten.
 */
export const SUPPRESS_CLICK_MS = 400;
export const SUPPRESS_CLICK_RADIUS_PX = 32;

/** Edge auto-scroll: the zone inside the visible scroller, and the step at the very edge, px per frame. */
export const EDGE_ZONE_PX = 48;
export const EDGE_MAX_STEP_PX = 18;

export type DragPhase = "idle" | "pressing" | "armed" | "dragging";
export type PointerKind = "mouse" | "touch" | "pen";

export interface Point {
  x: number;
  y: number;
}

export interface DragMachine {
  phase: DragPhase;
  pointerId: number | null;
  pointerType: PointerKind | null;
  /** The drag source the press began on (a device id). */
  sourceId: string | null;
  /** Slop is measured from here: the press point, then the point where the press armed. */
  anchor: Point | null;
  /** The pointer's latest position. */
  last: Point | null;
}

export const IDLE_DRAG: DragMachine = Object.freeze({ phase: "idle", pointerId: null, pointerType: null, sourceId: null, anchor: null, last: null });

export type DragInput =
  | { type: "down"; pointerId: number; pointerType: string; button: number; point: Point; sourceId: string | null }
  | { type: "longpress" }
  | { type: "move"; pointerId: number; point: Point }
  | { type: "up"; pointerId: number; point: Point }
  | { type: "cancel"; pointerId: number }
  | { type: "escape" };

/**
 * What the hook does after a step:
 *   schedule — start the long-press timer · arm — capture, vibrate, ghost and label
 *   start — the drag begins (from armed, or a mouse past its slop) · move — follow the pointer
 *   drop — commit at the release point · tap — the long press was a tap: open the rail
 *   cancel — the press or drag ends without a drop · none — nothing
 */
export type DragEffect = "none" | "schedule" | "arm" | "start" | "move" | "drop" | "tap" | "cancel";

export interface DragStepResult {
  state: DragMachine;
  effect: DragEffect;
}

function pointerKind(type: string): PointerKind {
  return type === "mouse" || type === "pen" ? type : "touch";
}

function distance(a: Point | null, b: Point): number {
  return a ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
}

const stay = (state: DragMachine): DragStepResult => ({ state, effect: "none" });
const end = (effect: DragEffect): DragStepResult => ({ state: IDLE_DRAG, effect });

function press(input: Extract<DragInput, { type: "down" }>): DragStepResult {
  const kind = pointerKind(input.pointerType);
  if (input.sourceId === null || (kind === "mouse" && input.button !== 0)) return stay(IDLE_DRAG);
  const state: DragMachine = { phase: "pressing", pointerId: input.pointerId, pointerType: kind, sourceId: input.sourceId, anchor: input.point, last: input.point };
  return { state, effect: kind === "mouse" ? "none" : "schedule" };
}

function moved(state: DragMachine, point: Point): DragStepResult {
  const next = { ...state, last: point };
  switch (state.phase) {
    case "pressing":
      if (state.pointerType === "mouse") {
        return distance(state.anchor, point) > MOUSE_SLOP_PX ? { state: { ...next, phase: "dragging" }, effect: "start" } : stay(next);
      }
      // The finger is scrolling, not picking: native scroll goes on.
      return distance(state.anchor, point) > SLOP_PX ? end("cancel") : stay(next);
    case "armed":
      return distance(state.anchor, point) > SLOP_PX ? { state: { ...next, phase: "dragging" }, effect: "start" } : stay(next);
    case "dragging":
      return { state: next, effect: "move" };
    default:
      return stay(state);
  }
}

function released(state: DragMachine): DragStepResult {
  if (state.phase === "dragging") return end("drop");
  if (state.phase === "armed") return end("tap");
  // Released while pressing: an ordinary click follows.
  return end("none");
}

export function dragStep(state: DragMachine, input: DragInput): DragStepResult {
  if (input.type === "down") return state.phase === "idle" ? press(input) : end("cancel");
  if (state.phase === "idle") return stay(state);
  switch (input.type) {
    case "longpress":
      if (state.phase !== "pressing" || state.pointerType === "mouse") return stay(state);
      return { state: { ...state, phase: "armed", anchor: state.last }, effect: "arm" };
    case "move":
      return input.pointerId === state.pointerId ? moved(state, input.point) : stay(state);
    case "up":
      return input.pointerId === state.pointerId ? released({ ...state, last: input.point }) : stay(state);
    case "cancel":
      return input.pointerId === state.pointerId ? end("cancel") : stay(state);
    case "escape":
      return end("cancel");
  }
}

/** One edge's scroll step for a pointer `inside` px from that edge (≤ 0: at or past it). */
function edgeStep(inside: number): number {
  if (inside >= EDGE_ZONE_PX) return 0;
  return Math.round(((EDGE_ZONE_PX - Math.max(0, inside)) / EDGE_ZONE_PX) * EDGE_MAX_STEP_PX);
}

/**
 * Edge auto-scroll while dragging: px to scroll this frame, from the
 * pointer's place in the VISIBLE part of the scroller (its rect clipped to
 * the visual viewport, so an iPad keyboard or a zoomed page does not hide
 * the zone).
 */
export function autoScrollStep(point: Point, visible: { left: number; top: number; right: number; bottom: number }): { dx: number; dy: number } {
  const dx = edgeStep(visible.right - point.x) - edgeStep(point.x - visible.left);
  const dy = edgeStep(visible.bottom - point.y) - edgeStep(point.y - visible.top);
  return { dx: dx === 0 ? 0 : dx, dy: dy === 0 ? 0 : dy };
}
