/**
 * Edge auto-scroll of a long-press drag (docs/PANEL_ENCLOSURE_R2.md §6.6,
 * §7.2). The step itself is the pure `autoScrollStep`; this module decides
 * WHAT scrolls and where the edge zones are.
 *
 *  - The drag's scroller (the drawing) has zones inside the part of it that
 *    is really on screen: its rect clipped to the visual viewport and to
 *    every ancestor that scrolls. The close-up's drawing scrolls only
 *    sideways and sits in a sheet body that scrolls up and down; unclipped,
 *    the bottom zone would lie below the sheet's edge, where no finger on
 *    the sheet can reach it.
 *  - Per axis, the scroller moves first, then each ancestor that scrolls on
 *    that axis, innermost first (the sheet body for the close-up,
 *    `main.content` in the wide layout), then the page.
 *  - An ancestor never moves from the drawing's zones. It has zones of its
 *    own, at the edges of what of it is on screen (its rect clipped to the
 *    ancestors around it and to the visual viewport), and moves only towards
 *    a side where the drawing, clipped to the ancestors inside it, still runs
 *    beyond that edge. The page is the outermost such ancestor, with the
 *    visual viewport as its edges. A drawing that ends mid-screen (a phone)
 *    or mid-`main.content` (an iPad in landscape) puts a finger on its
 *    bottom rail in the drawing's own zone; scrolling an ancestor there
 *    would push the drawing up under the still finger every frame until the
 *    ancestor ends, and the drop target with it.
 *  - The page never scrolls behind a fixed layer: a sheet is
 *    `position: fixed`, and scrolling the cabinet page under its backdrop
 *    only moves what the user cannot see.
 *
 * The ancestors are read once per drag (`scrollFrameOf`, computed styles),
 * the rects once per animation frame.
 */
import { autoScrollStep, type Point } from "./dragMachine";

type Rect = { left: number; top: number; right: number; bottom: number };

/** Where one drag may scroll, read from the scroller's ancestors when the drag starts. */
export interface ScrollFrame {
  /** Ancestors that scroll sideways, innermost first. */
  readonly x: readonly HTMLElement[];
  /** Ancestors that scroll up and down, innermost first. */
  readonly y: readonly HTMLElement[];
  /** Every scrolling ancestor, innermost first: the scroller is only seen through them. */
  readonly clips: readonly HTMLElement[];
  /** False inside a fixed layer (a sheet): the page behind it never scrolls. */
  readonly page: boolean;
}

const SCROLLING = new Set(["auto", "scroll", "overlay"]);

/** The scroller's scrolling ancestors up to the first fixed one (or the body), and whether the page may scroll. */
export function scrollFrameOf(element: HTMLElement): ScrollFrame {
  const x: HTMLElement[] = [];
  const y: HTMLElement[] = [];
  const clips: HTMLElement[] = [];
  let page = window.getComputedStyle(element).position !== "fixed";
  for (let node = element.parentElement; page && node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    const sideways = SCROLLING.has(style.overflowX);
    const upDown = SCROLLING.has(style.overflowY);
    if (sideways) x.push(node);
    if (upDown) y.push(node);
    if (sideways || upDown) clips.push(node);
    if (style.position === "fixed") page = false;
  }
  return Object.freeze({ x, y, clips, page });
}

const intersect = (a: Rect, b: Rect): Rect => ({
  left: Math.max(a.left, b.left),
  top: Math.max(a.top, b.top),
  right: Math.min(a.right, b.right),
  bottom: Math.min(a.bottom, b.bottom),
});

const rectOf = (element: Element): Rect => {
  const { left, top, right, bottom } = element.getBoundingClientRect();
  return { left, top, right, bottom };
};

/** The visual viewport (an iPad keyboard, a zoomed page) as a client rect. */
function screenRect(): Rect {
  const viewport = window.visualViewport;
  return {
    left: viewport?.offsetLeft ?? 0,
    top: viewport?.offsetTop ?? 0,
    right: (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth),
    bottom: (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight),
  };
}

/** The scroller's rect clipped to every scrolling ancestor: what the page could still bring on screen. */
const reachRect = (element: HTMLElement, clips: readonly HTMLElement[]): Rect =>
  clips.reduce((rect, clip) => intersect(rect, rectOf(clip)), rectOf(element));

/** The scroller's rect clipped to the visual viewport and to every scrolling ancestor. */
export function visibleRect(element: HTMLElement, clips: readonly HTMLElement[] = []): Rect | null {
  const visible = intersect(reachRect(element, clips), screenRect());
  return visible.right - visible.left > 0 && visible.bottom - visible.top > 0 ? visible : null;
}

type Axis = "x" | "y";

/**
 * The step of an ancestor (or the page) that brings the drawing into view:
 * zones at the edges of `shown`, what of the ancestor is on screen, and only
 * towards a side where the drawing (`reach`) still runs beyond that edge —
 * so it stops once the drawing's edge is on screen, never at its own end.
 */
function towardsHidden(point: Point, shown: Rect, reach: Rect, axis: Axis): number {
  const { dx, dy } = autoScrollStep(point, shown);
  if (axis === "x") return (dx > 0 && reach.right > shown.right) || (dx < 0 && reach.left < shown.left) ? dx : 0;
  return (dy > 0 && reach.bottom > shown.bottom) || (dy < 0 && reach.top < shown.top) ? dy : 0;
}

/** One scrolling ancestor's step: from its own visible edges, towards the drawing it still hides. */
function ancestorStep(element: HTMLElement, ancestor: HTMLElement, point: Point, frame: ScrollFrame, axis: Axis): number {
  const at = frame.clips.indexOf(ancestor);
  const split = at < 0 ? frame.clips.length : at;
  const shown = intersect(reachRect(ancestor, frame.clips.slice(split + 1)), screenRect());
  if (shown.right <= shown.left || shown.bottom <= shown.top) return 0;
  return towardsHidden(point, shown, reachRect(element, frame.clips.slice(0, split)), axis);
}

/** The page's step: the visual viewport's edges, towards the drawing still hidden beyond them. */
function pageStep(element: HTMLElement, point: Point, frame: ScrollFrame, axis: Axis): number {
  return frame.page ? towardsHidden(point, screenRect(), reachRect(element, frame.clips), axis) : 0;
}

/** Scroll one element along one axis, within its range. True when it moved. */
function moveBy(element: HTMLElement, delta: number, axis: Axis): boolean {
  if (delta === 0) return false;
  const position = axis === "x" ? element.scrollLeft : element.scrollTop;
  const max = axis === "x" ? element.scrollWidth - element.clientWidth : element.scrollHeight - element.clientHeight;
  const next = Math.max(0, Math.min(max, position + delta));
  if (next === position) return false;
  if (axis === "x") element.scrollLeft = next;
  else element.scrollTop = next;
  return true;
}

/**
 * One axis: the drawing by its own step, else the first ancestor that has a
 * step and can go it, else the page. True when anything moved.
 */
function scrollAxis(element: HTMLElement, own: number, point: Point, frame: ScrollFrame, axis: Axis): boolean {
  if (moveBy(element, own, axis)) return true;
  const ancestors = axis === "x" ? frame.x : frame.y;
  if (ancestors.some((ancestor) => moveBy(ancestor, ancestorStep(element, ancestor, point, frame, axis), axis))) return true;
  const pageDelta = pageStep(element, point, frame, axis);
  if (pageDelta === 0) return false;
  const before = axis === "x" ? window.scrollX : window.scrollY;
  window.scrollBy(axis === "x" ? pageDelta : 0, axis === "y" ? pageDelta : 0);
  return (axis === "x" ? window.scrollX : window.scrollY) !== before;
}

/** One frame of edge auto-scroll for a finger at `point`. True when anything moved. */
export function autoScroll(element: HTMLElement, point: Point | null, frame: ScrollFrame): boolean {
  const visible = point ? visibleRect(element, frame.clips) : null;
  if (!point || !visible) return false;
  const own = autoScrollStep(point, visible);
  const horizontal = scrollAxis(element, own.dx, point, frame, "x");
  const vertical = scrollAxis(element, own.dy, point, frame, "y");
  return horizontal || vertical;
}
