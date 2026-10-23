/**
 * The page step of the drag's edge auto-scroll (docs/PANEL_ENCLOSURE_R2.md
 * §6.6). On a phone the Schrank drawing often fits on screen: its scroller
 * cannot scroll up and down and ends mid-screen, with "Hinweise zum Schrank"
 * below it. A finger held on the bottom rail sits in the scroller's own edge
 * zone, but scrolling the PAGE there only pushes the drawing up under the
 * finger, every frame, until the page ends. So the page scrolls only for a
 * finger in the zone at the edge of the visual viewport, and only towards a
 * side where part of the scroller is still hidden beyond that edge.
 *
 * The same rule holds for every scrolling ANCESTOR after the scroller. In
 * the wide layout (1180 × 820 iPad landscape, 1366 × 1024) the window never
 * scrolls: `main.content` does. It takes its step from the zones at the edges
 * of what of it is on screen, and only towards a side where the drawing still
 * runs beyond that edge — never from the drawing's own zones, where a finger
 * held still near the bottom rail ran `main.content` to its end (R1).
 *
 * jsdom computes no layout: rects, scroll extents and the window's scroll
 * position are given here, and `scrollBy` (or the ancestor's `scrollTop`)
 * moves the scroller's rect the way a real scroll would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { autoScroll, type ScrollFrame } from "../components/schaltplan/enclosure/dragAutoScroll";
import { EDGE_ZONE_PX } from "../components/schaltplan/enclosure/dragMachine";

type Box = { left: number; top: number; right: number; bottom: number };

const PHONE = { width: 390, height: 844 };
const PAGE_END = 1966;
const PAGE: ScrollFrame = Object.freeze({ x: [], y: [], clips: [], page: true });

const page = { x: 0, y: 0 };
let scrollBy: ReturnType<typeof vi.fn>;

/** A scroller that cannot scroll up and down (the drawing fits), sideways as given. */
function scroller(box: Box, scrollWidth = box.right - box.left): { element: HTMLElement; rect: () => Box } {
  const element = document.createElement("div");
  // The rect follows the page: a page scrolled 10 px further shows the scroller 10 px higher.
  const origin = { x: page.x, y: page.y };
  const rect = (): Box => ({
    left: box.left - (page.x - origin.x),
    right: box.right - (page.x - origin.x),
    top: box.top - (page.y - origin.y),
    bottom: box.bottom - (page.y - origin.y),
  });
  element.getBoundingClientRect = () => {
    const r = rect();
    return { ...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, toJSON: () => r } as DOMRect;
  };
  const height = box.bottom - box.top;
  Object.defineProperties(element, {
    scrollWidth: { configurable: true, get: () => scrollWidth },
    clientWidth: { configurable: true, get: () => box.right - box.left },
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, get: () => height },
    scrollTop: { configurable: true, writable: true, value: 0 },
    scrollLeft: { configurable: true, writable: true, value: 0 },
  });
  return { element, rect };
}

/** Frames of a finger held still at `point`; the total the page moved. */
function hold(element: HTMLElement, point: { x: number; y: number }, frames: number, frame: ScrollFrame = PAGE): { dx: number; dy: number } {
  const start = { x: page.x, y: page.y };
  for (let i = 0; i < frames; i += 1) autoScroll(element, point, frame);
  return { dx: page.x - start.x, dy: page.y - start.y };
}

const WIDE = { width: 1180, height: 820 };
/** `main.content` of the wide layout: beside the sidebar, the full screen height; its scroll range ends at 1286. */
const MAIN: Box = { left: 240, top: 0, right: WIDE.width, bottom: WIDE.height };
const MAIN_END = 1286;

const domRect = (r: Box) => ({ ...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, toJSON: () => r }) as DOMRect;

/**
 * The wide layout: the drawing (no scroll range of its own) inside
 * `main.content`, which scrolls up and down from `scrollTop`; `drawing` is
 * where the drawing sits at that scroll position.
 */
function wideLayout(drawing: Box, scrollTop: number) {
  const main = document.createElement("main");
  let top = scrollTop;
  main.getBoundingClientRect = () => domRect(MAIN);
  Object.defineProperties(main, {
    scrollWidth: { configurable: true, get: () => MAIN.right - MAIN.left },
    clientWidth: { configurable: true, get: () => MAIN.right - MAIN.left },
    scrollHeight: { configurable: true, get: () => MAIN.bottom - MAIN.top + MAIN_END },
    clientHeight: { configurable: true, get: () => MAIN.bottom - MAIN.top },
    scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = value; } },
    scrollLeft: { configurable: true, get: () => 0, set: () => undefined },
  });
  const element = document.createElement("div");
  const rect = (): Box => ({ ...drawing, top: drawing.top - (top - scrollTop), bottom: drawing.bottom - (top - scrollTop) });
  element.getBoundingClientRect = () => domRect(rect());
  const height = drawing.bottom - drawing.top;
  Object.defineProperties(element, {
    scrollWidth: { configurable: true, get: () => drawing.right - drawing.left },
    clientWidth: { configurable: true, get: () => drawing.right - drawing.left },
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, get: () => height },
    scrollTop: { configurable: true, writable: true, value: 0 },
    scrollLeft: { configurable: true, writable: true, value: 0 },
  });
  // overflow-y: auto computes overflow-x to auto as well: main.content is on both axes.
  const frame: ScrollFrame = Object.freeze({ x: [main], y: [main], clips: [main], page: true });
  return { element, main, rect, frame };
}

const WINDOW_KEYS = ["innerWidth", "innerHeight", "scrollX", "scrollY", "scrollBy"] as const;
let saved: Map<string, PropertyDescriptor | undefined>;
const define = (key: string, get: () => number) => Object.defineProperty(window, key, { configurable: true, get });

beforeEach(() => {
  saved = new Map(WINDOW_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(window, key)]));
  page.x = 0;
  page.y = 1685;
  define("innerWidth", () => PHONE.width);
  define("innerHeight", () => PHONE.height);
  define("scrollX", () => page.x);
  define("scrollY", () => page.y);
  scrollBy = vi.fn((dx: number, dy: number) => {
    page.x = Math.max(0, page.x + dx);
    page.y = Math.max(0, Math.min(PAGE_END, page.y + dy));
  });
  Object.defineProperty(window, "scrollBy", { configurable: true, writable: true, value: scrollBy });
});

afterEach(() => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(window, key, descriptor);
    else delete (window as unknown as Record<string, unknown>)[key];
  }
});

describe("autoScroll — the page on a phone", () => {
  it("does not scroll the page for a finger held on the bottom rail of a drawing that ends mid-screen", () => {
    // 390 × 844, zoom 2/6: the drawing spans y 93–457 and fits; the bottom rail sits at y ≈ 422.
    const { element } = scroller({ left: 0, top: 93, right: PHONE.width, bottom: 457 });
    expect(autoScroll(element, { x: 200, y: 422 }, PAGE)).toBe(false);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("never runs the page to its end while the finger stays still below the drawing", () => {
    const { element, rect } = scroller({ left: 0, top: 93, right: PHONE.width, bottom: 457 });
    const moved = hold(element, { x: 200, y: 470 }, 60);
    expect(moved.dy).toBe(0);
    expect(rect().top).toBe(93);
  });

  it("does not scroll the page up for a finger on the top rail of a drawing that starts mid-screen", () => {
    const { element } = scroller({ left: 0, top: 400, right: PHONE.width, bottom: 700 });
    expect(autoScroll(element, { x: 200, y: 400 + EDGE_ZONE_PX / 4 }, PAGE)).toBe(false);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("does not scroll the page sideways at the right rail end of a drawing that fits the width", () => {
    const { element } = scroller({ left: 16, top: 93, right: PHONE.width - 16, bottom: 457 });
    expect(autoScroll(element, { x: PHONE.width - 16 - EDGE_ZONE_PX / 4, y: 300 }, PAGE)).toBe(false);
    expect(scrollBy).not.toHaveBeenCalled();
  });
});

describe("autoScroll — the page still helps where the drawing runs off screen", () => {
  it("scrolls down for a finger at the bottom of the screen while the drawing runs on below it", () => {
    const { element } = scroller({ left: 0, top: 300, right: PHONE.width, bottom: 1200 });
    expect(autoScroll(element, { x: 200, y: PHONE.height - EDGE_ZONE_PX / 4 }, PAGE)).toBe(true);
    const [dx, dy] = scrollBy.mock.calls[0] as [number, number];
    expect(dx).toBe(0);
    expect(dy).toBeGreaterThan(0);
  });

  it("stops once the drawing's bottom is on screen, long before the page ends", () => {
    const { element, rect } = scroller({ left: 0, top: 300, right: PHONE.width, bottom: 1000 });
    hold(element, { x: 200, y: PHONE.height - EDGE_ZONE_PX / 4 }, 200);
    expect(rect().bottom).toBeLessThanOrEqual(PHONE.height);
    expect(rect().bottom).toBeGreaterThan(PHONE.height - 20);
    expect(page.y).toBeLessThan(PAGE_END);
  });

  it("scrolls up for a finger at the top of the screen while the drawing starts above it", () => {
    const { element } = scroller({ left: 0, top: -200, right: PHONE.width, bottom: 600 });
    expect(autoScroll(element, { x: 200, y: EDGE_ZONE_PX / 4 }, PAGE)).toBe(true);
    const [, dy] = scrollBy.mock.calls[0] as [number, number];
    expect(dy).toBeLessThan(0);
  });

  it("scrolls the scroller itself sideways first, never the page, while it can still move", () => {
    const { element } = scroller({ left: 0, top: 93, right: PHONE.width, bottom: 457 }, 1200);
    expect(autoScroll(element, { x: PHONE.width - EDGE_ZONE_PX / 4, y: 300 }, PAGE)).toBe(true);
    expect(element.scrollLeft).toBeGreaterThan(0);
    expect(scrollBy).not.toHaveBeenCalled();
  });
});

describe("autoScroll — main.content in the wide layout (iPad landscape)", () => {
  beforeEach(() => {
    define("innerWidth", () => WIDE.width);
    define("innerHeight", () => WIDE.height);
  });

  it("leaves main.content alone for a finger held still near the bottom edge of a drawing that is on screen", () => {
    // 1180 × 820, UV1 on the Schrank tab: the drawing at y 123–738, LS F5.3 on the bottom rail 44 px above its edge.
    const { element, main, rect, frame } = wideLayout({ left: 264, top: 123, right: 1156, bottom: 738 }, 1033);
    expect(autoScroll(element, { x: 600, y: 738 - 44 }, frame)).toBe(false);
    hold(element, { x: 600, y: 738 - 44 }, 60, frame);
    hold(element, { x: 600, y: 738 - 20 }, 60, frame);
    expect(main.scrollTop).toBe(1033);
    expect(rect().top).toBe(123);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("leaves main.content alone for a finger at the screen's edge while the whole drawing is on screen", () => {
    const { element, main, rect, frame } = wideLayout({ left: 264, top: 123, right: 1156, bottom: 738 }, 1033);
    hold(element, { x: 600, y: WIDE.height - 4 }, 60, frame);
    hold(element, { x: 600, y: 4 }, 60, frame);
    expect(main.scrollTop).toBe(1033);
    expect(rect().top).toBe(123);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("scrolls main.content down for a finger at the screen's bottom edge while the drawing runs on below it, and stops once its bottom shows", () => {
    const { element, main, rect, frame } = wideLayout({ left: 264, top: 500, right: 1156, bottom: 1115 }, 600);
    expect(autoScroll(element, { x: 600, y: WIDE.height - EDGE_ZONE_PX / 4 }, frame)).toBe(true);
    expect(main.scrollTop).toBeGreaterThan(600);
    hold(element, { x: 600, y: WIDE.height - EDGE_ZONE_PX / 4 }, 200, frame);
    expect(rect().bottom).toBeLessThanOrEqual(WIDE.height);
    expect(rect().bottom).toBeGreaterThan(WIDE.height - 20);
    expect(main.scrollTop).toBeLessThan(MAIN_END);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("scrolls main.content up for a finger at its top edge while the drawing starts above it, and stops once its top shows", () => {
    const { element, main, rect, frame } = wideLayout({ left: 264, top: -300, right: 1156, bottom: 315 }, 1000);
    expect(autoScroll(element, { x: 600, y: EDGE_ZONE_PX / 4 }, frame)).toBe(true);
    expect(main.scrollTop).toBeLessThan(1000);
    hold(element, { x: 600, y: EDGE_ZONE_PX / 4 }, 200, frame);
    expect(rect().top).toBeGreaterThanOrEqual(0);
    expect(rect().top).toBeLessThan(20);
    expect(main.scrollTop).toBeGreaterThan(0);
  });
});
