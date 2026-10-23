/**
 * Edge auto-scroll of the long-press drag inside a sheet
 * (docs/PANEL_ENCLOSURE_R2.md §6.6, §7.2). The close-up's drawing scroller
 * only scrolls sideways; what scrolls up and down is the sheet's body, in a
 * fixed sheet. So the edge zones sit inside the part of the scroller the
 * body shows, the body scrolls on the vertical axis, and the page behind a
 * fixed sheet never scrolls. Outside a fixed layer the page still takes
 * over when nothing else can move. In the wide layout `main.content` scrolls
 * instead of the window: it moves only from the zones at its own visible
 * edges, and only while the drawing still runs beyond that edge.
 *
 * jsdom computes no layout: rects and scroll extents are given per element.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";

import { EDGE_ZONE_PX, LONG_PRESS_MS } from "../components/schaltplan/enclosure/dragMachine";
import { DRAG_SOURCE_ATTRIBUTE, useLongPressDrag } from "../components/schaltplan/enclosure/useLongPressDrag";

type Box = { left: number; top: number; right: number; bottom: number };

const BODY_BOTTOM = 760;

type Layer = "sheet" | "page" | "main";

function Harness({ layer }: { layer: Layer }) {
  const ref = useRef<HTMLDivElement>(null);
  useLongPressDrag({
    scrollRef: ref,
    enabled: true,
    onStart: () => undefined,
    onMove: () => undefined,
    onDrop: () => undefined,
    onCancel: () => undefined,
    onTap: () => undefined,
  });
  return (
    <div data-testid="layer" style={layer === "sheet" ? { position: "fixed" } : undefined}>
      <div data-testid="body" style={layer === "page" ? undefined : { overflowY: "auto" }}>
        <div ref={ref} data-testid="scroller" style={{ overflowX: "auto", overflowY: "hidden" }}>
          <svg>
            <rect data-testid="source" {...{ [DRAG_SOURCE_ATTRIBUTE]: "dev-f3:leiste" }} />
          </svg>
        </div>
      </div>
    </div>
  );
}

/** A rect and scroll extents for one element; `scrollTop` / `scrollLeft` are kept per element. */
function lay(element: HTMLElement, box: Box, extent: { width: number; height: number; clientWidth: number; clientHeight: number }) {
  const scroll = { top: 0, left: 0 };
  element.getBoundingClientRect = () => ({ ...box, x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top, toJSON: () => box }) as DOMRect;
  Object.defineProperties(element, {
    scrollWidth: { configurable: true, get: () => extent.width },
    scrollHeight: { configurable: true, get: () => extent.height },
    clientWidth: { configurable: true, get: () => extent.clientWidth },
    clientHeight: { configurable: true, get: () => extent.clientHeight },
    scrollTop: { configurable: true, get: () => scroll.top, set: (value: number) => { scroll.top = value; } },
    scrollLeft: { configurable: true, get: () => scroll.left, set: (value: number) => { scroll.left = value; } },
  });
  return scroll;
}

function setup(layer: Layer) {
  const view = render(<Harness layer={layer} />);
  // The sheet body shows y 100–760 of the 768 px window; the drawing inside it runs on to 1100 (rail 2 below the fold).
  const body = lay(view.getByTestId("body"), { left: 0, top: 100, right: 800, bottom: BODY_BOTTOM }, { width: 800, height: 1400, clientWidth: 800, clientHeight: 660 });
  lay(view.getByTestId("scroller"), { left: 0, top: 120, right: 800, bottom: 1100 }, { width: 800, height: 980, clientWidth: 800, clientHeight: 980 });
  return { ...view, body, source: view.getByTestId("source") };
}

const touch = { pointerId: 1, pointerType: "touch", button: 0 };
const frames = (n: number) => act(() => vi.advanceTimersByTime(20 * n));

function dragTo(source: Element, x: number, y: number) {
  fireEvent.pointerDown(source, { ...touch, clientX: 400, clientY: 300 });
  act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
  fireEvent.pointerMove(source, { ...touch, clientX: x, clientY: y });
}

let scrollBy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers();
  scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => undefined);
});
afterEach(() => {
  scrollBy.mockRestore();
  vi.useRealTimers();
});

describe("useLongPressDrag — auto-scroll in a sheet", () => {
  it("scrolls the sheet body near the bottom of what the body shows, not the page behind it", () => {
    const { body, source } = setup("sheet");
    dragTo(source, 400, BODY_BOTTOM - EDGE_ZONE_PX / 4);
    frames(3);
    expect(body.top).toBeGreaterThan(0);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("never scrolls the page behind a fixed sheet, even with the body at its end", () => {
    const { body, source } = setup("sheet");
    body.top = 740;
    dragTo(source, 400, BODY_BOTTOM - EDGE_ZONE_PX / 4);
    frames(3);
    expect(body.top).toBe(740);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("leaves the middle of the visible body alone", () => {
    const { body, source } = setup("sheet");
    dragTo(source, 400, 400);
    frames(3);
    expect(body.top).toBe(0);
    expect(scrollBy).not.toHaveBeenCalled();
  });
});

describe("useLongPressDrag — auto-scroll on the page", () => {
  it("scrolls the page when the scroller cannot go further and no sheet holds it", () => {
    const { source } = setup("page");
    dragTo(source, 400, window.innerHeight - EDGE_ZONE_PX / 4);
    frames(1);
    expect(scrollBy).toHaveBeenCalled();
    const [dx, dy] = scrollBy.mock.calls[0] as [number, number];
    expect(dx).toBe(0);
    expect(dy).toBeGreaterThan(0);
  });

  it("leaves the page alone for a finger held on the bottom rail of a drawing that ends mid-screen (a phone)", () => {
    const view = setup("page");
    // The drawing fits: y 93–457 of the 768 px window, no vertical range; "Hinweise zum Schrank" below it.
    lay(view.getByTestId("scroller"), { left: 0, top: 93, right: 800, bottom: 457 }, { width: 800, height: 364, clientWidth: 800, clientHeight: 364 });
    dragTo(view.source, 400, 457 - EDGE_ZONE_PX / 4);
    frames(30);
    expect(scrollBy).not.toHaveBeenCalled();
  });
});

describe("useLongPressDrag — auto-scroll in main.content (the wide layout)", () => {
  /** main.content shows y 0–768 beside the sidebar and scrolls up and down; the window does not. */
  function wide(drawing: Box) {
    const view = render(<Harness layer="main" />);
    const main = lay(view.getByTestId("body"), { left: 240, top: 0, right: 1024, bottom: 768 }, { width: 784, height: 2400, clientWidth: 784, clientHeight: 768 });
    main.top = 1033;
    const height = drawing.bottom - drawing.top;
    lay(view.getByTestId("scroller"), drawing, { width: 760, height, clientWidth: 760, clientHeight: height });
    return { main, source: view.getByTestId("source") };
  }

  it("leaves main.content alone for a finger held still near the bottom edge of a drawing that is on screen", () => {
    const { main, source } = wide({ left: 252, top: 123, right: 1012, bottom: 700 });
    dragTo(source, 400, 700 - 44);
    frames(30);
    expect(main.top).toBe(1033);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("scrolls main.content for a finger at its bottom edge while the drawing runs on below it", () => {
    const { main, source } = wide({ left: 252, top: 300, right: 1012, bottom: 1100 });
    dragTo(source, 400, 768 - EDGE_ZONE_PX / 4);
    frames(3);
    expect(main.top).toBeGreaterThan(1033);
    expect(scrollBy).not.toHaveBeenCalled();
  });
});
