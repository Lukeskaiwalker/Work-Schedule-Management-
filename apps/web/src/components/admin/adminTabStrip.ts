/**
 * Geometry for the Verwaltungszentrum's tab strip — a row of tabs that is its
 * own horizontal scroller, because on a phone (and on a tablet next to the
 * sidebar) the eight sections do not fit the width, and the page root clips
 * anything wider than the screen (`html, body { overflow-x: clip }`).
 *
 * Pure numbers in, numbers out: jsdom has no layout, so the component reads
 * the browser's measurements and hands them here, and the tests feed these
 * functions directly.
 */

/** What the strip's scroll state looks like, in CSS px. */
export type StripViewport = {
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
};

/** A tab's position along the strip's scrollable content, in CSS px. */
export type StripItem = {
  left: number;
  width: number;
};

/**
 * How far a revealed tab is kept from the strip's edge. The edge fade that
 * hints at more tabs is 28 px wide (admin-mobile.css); a tab parked inside it
 * would read as "there is more" rather than as the tab you are on.
 */
export const STRIP_EDGE_MARGIN = 32;

/** A measurement this close to an edge counts as being at it (sub-pixel scroll positions). */
const EDGE_TOLERANCE = 1;

/** A tab's `scroll-snap-align` along the strip. */
export type SnapAlign = "start" | "center" | "end" | "none";

/** The strip's `scroll-padding` at its start and end edge, in CSS px. */
export type SnapPadding = { start: number; end: number };

export type RevealOptions = {
  /** Distance kept from the edge; defaults to STRIP_EDGE_MARGIN. */
  margin?: number;
  /**
   * The scroll positions the strip comes to rest at, when it snaps
   * (snapOffsetOf for each tab). A reveal that ends between two of them is
   * pulled to the nearer one by the browser — on a phone that put the tab
   * back under the edge fade, or partly off the strip — so with these the
   * reveal ends on one of them.
   */
  snapOffsets?: readonly number[];
};

function maxScrollOf(view: StripViewport): number {
  return Math.max(0, view.scrollWidth - view.clientWidth);
}

function clampScroll(view: StripViewport, left: number): number {
  return Math.min(maxScrollOf(view), Math.max(0, left));
}

/**
 * The scrollLeft at which a snapping strip rests on `item`: the item's
 * aligned edge on the snapport's (the strip less its scroll-padding). A
 * position past either end of the strip is clamped to it, as browsers do.
 * Null for an item that does not snap.
 */
export function snapOffsetOf(
  view: StripViewport,
  item: StripItem,
  align: SnapAlign,
  padding: SnapPadding,
): number | null {
  const port = view.clientWidth - padding.start - padding.end;
  switch (align) {
    case "start":
      return clampScroll(view, item.left - padding.start);
    case "end":
      return clampScroll(view, item.left + item.width - (padding.start + port));
    case "center":
      return clampScroll(view, item.left + item.width / 2 - (padding.start + port / 2));
    default:
      return null;
  }
}

/** The snap position nearest `target` on the side that keeps the margin; the strip's end when there is none. */
function snappedTarget(view: StripViewport, target: number, towardsEnd: boolean, snaps: readonly number[]): number {
  const positions = snaps.map((left) => clampScroll(view, left));
  if (towardsEnd) {
    const beyond = positions.filter((left) => left >= target - EDGE_TOLERANCE);
    return beyond.length > 0 ? Math.min(...beyond) : maxScrollOf(view);
  }
  const before = positions.filter((left) => left <= target + EDGE_TOLERANCE);
  return before.length > 0 ? Math.max(...before) : 0;
}

/**
 * The scrollLeft that brings `item` fully into view with the margin, or null
 * when it already is — moving a strip the reader did not ask to move is
 * worse than leaving a tab near the edge. Scrolls the least distance that
 * works (on a snapping strip: the nearest snap position that works), and
 * never past either end of the strip.
 */
export function scrollLeftToReveal(view: StripViewport, item: StripItem, options: RevealOptions = {}): number | null {
  const margin = options.margin ?? STRIP_EDGE_MARGIN;
  const viewStart = view.scrollLeft;
  const viewEnd = view.scrollLeft + view.clientWidth;
  const itemStart = item.left;
  const itemEnd = item.left + item.width;

  let target: number | null = null;
  let towardsEnd = false;
  if (itemStart - margin < viewStart) {
    target = itemStart - margin;
  } else if (itemEnd + margin > viewEnd) {
    target = itemEnd + margin - view.clientWidth;
    towardsEnd = true;
  }
  if (target === null) return null;

  const snaps = options.snapOffsets ?? [];
  const landing =
    snaps.length > 0 ? snappedTarget(view, clampScroll(view, target), towardsEnd, snaps) : clampScroll(view, target);
  return Math.abs(landing - view.scrollLeft) < EDGE_TOLERANCE ? null : landing;
}

/** Which edges have tabs scrolled out of sight behind them. */
export function stripEdges(view: StripViewport): { start: boolean; end: boolean } {
  return {
    start: view.scrollLeft > EDGE_TOLERANCE,
    end: view.scrollLeft + view.clientWidth < view.scrollWidth - EDGE_TOLERANCE,
  };
}

/**
 * Where an arrow, Home or End moves the focus from `current`; null for any
 * other key. The arrows wrap at the ends, as in the WAI-ARIA tabs pattern.
 */
export function tabAfterKey<T>(tabs: readonly T[], current: T, key: string): T | null {
  if (tabs.length === 0) return null;
  const index = Math.max(0, tabs.indexOf(current));
  const last = tabs.length - 1;
  switch (key) {
    case "ArrowRight":
      return tabs[index === last ? 0 : index + 1];
    case "ArrowLeft":
      return tabs[index === 0 ? last : index - 1];
    case "Home":
      return tabs[0];
    case "End":
      return tabs[last];
    default:
      return null;
  }
}
