/**
 * The long-press drag hook on real (jsdom) pointer events
 * (docs/PANEL_ENCLOSURE_R2.md §6.2, §6.6, §14.3): a short tap stays a click,
 * a slow tap released in place is still a tap, a long press then a move is
 * a drag, a finger that moves first scrolls, a mouse drags after 6 px.
 * Escape, pointercancel and a new pointer abort; a resting thumb does not.
 * The click after a drop is swallowed, `contextmenu` is prevented, and the
 * iPad touchmove guard is registered non-passive at mount and cancels only
 * while a drag is armed or running. jsdom has no `setPointerCapture`: the
 * hook must not throw without it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";

import { LONG_PRESS_MS, SUPPRESS_CLICK_MS } from "../components/schaltplan/enclosure/dragMachine";
import { DRAG_SOURCE_ATTRIBUTE, useLongPressDrag, type LongPressDragHandlers } from "../components/schaltplan/enclosure/useLongPressDrag";

function makeSpies() {
  return {
    onStart: vi.fn<LongPressDragHandlers["onStart"]>(),
    onMove: vi.fn<LongPressDragHandlers["onMove"]>(),
    onDrop: vi.fn<LongPressDragHandlers["onDrop"]>(),
    onCancel: vi.fn<LongPressDragHandlers["onCancel"]>(),
    onTap: vi.fn<LongPressDragHandlers["onTap"]>(),
    click: vi.fn<() => void>(),
  };
}
type Spies = ReturnType<typeof makeSpies>;

function Harness({ spies, enabled = true }: { spies: Spies; enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const { click: _click, ...handlers } = spies;
  useLongPressDrag({ scrollRef: ref, enabled, ...handlers });
  return (
    <div ref={ref} data-testid="scroller">
      <svg data-testid="svg">
        <rect data-testid="source" {...{ [DRAG_SOURCE_ATTRIBUTE]: "ls1" }} onClick={spies.click} />
        <rect data-testid="background" />
      </svg>
    </div>
  );
}

function setup(enabled = true) {
  const spies = makeSpies();
  const view = render(<Harness spies={spies} enabled={enabled} />);
  return { ...view, spies, source: view.getByTestId("source"), background: view.getByTestId("background"), scroller: view.getByTestId("scroller") };
}

const at = (x: number, y = 100) => ({ clientX: x, clientY: y });
const touch = (pointerId = 1) => ({ pointerId, pointerType: "touch", button: 0, isPrimary: pointerId === 1 });
const mouse = { pointerId: 1, pointerType: "mouse", button: 0 };
const frame = () => act(() => vi.advanceTimersByTime(20));

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useLongPressDrag — taps stay taps", () => {
  it("a short tap is an ordinary click: no drag, nothing swallowed", () => {
    const { spies, source } = setup();
    fireEvent.pointerDown(source, { ...touch(), ...at(100) });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS - 100));
    fireEvent.pointerUp(source, { ...touch(), ...at(100) });
    fireEvent.click(source);
    expect(spies.click).toHaveBeenCalledTimes(1);
    expect(spies.onStart).not.toHaveBeenCalled();
    expect(spies.onTap).not.toHaveBeenCalled();
  });

  it("held 700 ms without moving and released: one tap, no drop — and the next tap works", () => {
    const { spies, source } = setup();
    fireEvent.pointerDown(source, { ...touch(), ...at(100) });
    act(() => vi.advanceTimersByTime(700));
    expect(spies.onStart).toHaveBeenCalledWith("ls1", { x: 100, y: 100 });
    fireEvent.pointerUp(source, { ...touch(), ...at(101) });
    // A click the browser may send for the same touch would land on the sheet's backdrop: swallowed.
    fireEvent.click(source, at(101));
    expect(spies.onTap).toHaveBeenCalledTimes(1);
    // With the element the press began on: a strip's tap can still select the terminal under the finger.
    expect(spies.onTap).toHaveBeenCalledWith("ls1", source);
    expect(spies.click).not.toHaveBeenCalled();
    expect(spies.onDrop).not.toHaveBeenCalled();
    expect(spies.onCancel).toHaveBeenCalledTimes(1);

    // One click only: the next tap — even right away — goes through.
    fireEvent.click(source, at(101));
    expect(spies.click).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(SUPPRESS_CLICK_MS + 1));
    fireEvent.click(source, at(101));
    expect(spies.click).toHaveBeenCalledTimes(2);
  });
});

describe("useLongPressDrag — drags", () => {
  it("long press, then a move past the slop, drags; release drops at the release point", () => {
    const { spies, source } = setup();
    fireEvent.pointerDown(source, { ...touch(), ...at(100) });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    expect(spies.onStart).toHaveBeenCalledTimes(1);
    fireEvent.pointerMove(source, { ...touch(), ...at(130, 120) });
    frame();
    expect(spies.onMove).toHaveBeenLastCalledWith({ x: 130, y: 120 });
    fireEvent.pointerMove(source, { ...touch(), ...at(160, 140) });
    fireEvent.pointerMove(source, { ...touch(), ...at(170, 150) });
    frame();
    // Moves land in one frame: the latest point only.
    expect(spies.onMove).toHaveBeenLastCalledWith({ x: 170, y: 150 });
    fireEvent.pointerUp(source, { ...touch(), ...at(175, 150) });
    expect(spies.onDrop).toHaveBeenCalledWith({ x: 175, y: 150 });
    expect(spies.onCancel).not.toHaveBeenCalled();

    // The click that follows a drop, where it was released, is swallowed …
    fireEvent.click(source, at(175, 150));
    expect(spies.click).not.toHaveBeenCalled();
  });

  it("… but a tap elsewhere right after a drop (Rückgängig) goes through", () => {
    const { spies, source } = setup();
    fireEvent.pointerDown(source, { ...mouse, ...at(100) });
    fireEvent.pointerMove(source, { ...mouse, ...at(150) });
    fireEvent.pointerUp(source, { ...mouse, ...at(150) });
    fireEvent.click(source, at(400, 700));
    expect(spies.click).toHaveBeenCalledTimes(1);
  });

  it("a finger that moves more than 8 px before the long press scrolls instead", () => {
    const { spies, source } = setup();
    fireEvent.pointerDown(source, { ...touch(), ...at(100) });
    fireEvent.pointerMove(source, { ...touch(), ...at(110) });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS + 100));
    fireEvent.pointerUp(source, { ...touch(), ...at(110) });
    expect(spies.onStart).not.toHaveBeenCalled();
    expect(spies.onDrop).not.toHaveBeenCalled();
  });

  it("a mouse drags after 6 px, at once", () => {
    const { spies, source } = setup();
    fireEvent.pointerDown(source, { ...mouse, ...at(100) });
    fireEvent.pointerMove(source, { ...mouse, ...at(106) });
    expect(spies.onStart).not.toHaveBeenCalled();
    fireEvent.pointerMove(source, { ...mouse, ...at(108) });
    expect(spies.onStart).toHaveBeenCalledWith("ls1", { x: 108, y: 100 });
    frame();
    fireEvent.pointerUp(source, { ...mouse, ...at(140) });
    expect(spies.onDrop).toHaveBeenCalledWith({ x: 140, y: 100 });
  });

  it("starts nothing off a drag source, and nothing while disabled", () => {
    const off = setup(false);
    fireEvent.pointerDown(off.source, { ...mouse, ...at(100) });
    fireEvent.pointerMove(off.source, { ...mouse, ...at(150) });
    expect(off.spies.onStart).not.toHaveBeenCalled();
    off.unmount();

    const on = setup();
    fireEvent.pointerDown(on.background, { ...mouse, ...at(100) });
    fireEvent.pointerMove(on.background, { ...mouse, ...at(150) });
    expect(on.spies.onStart).not.toHaveBeenCalled();
  });
});

describe("useLongPressDrag — aborts", () => {
  it("Escape and pointercancel abort an armed drag", () => {
    const first = setup();
    fireEvent.pointerDown(first.source, { ...touch(), ...at(100) });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(first.spies.onCancel).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(first.source, { ...touch(), ...at(100) });
    expect(first.spies.onTap).not.toHaveBeenCalled();
    first.unmount();

    const second = setup();
    fireEvent.pointerDown(second.source, { ...touch(), ...at(100) });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    fireEvent.pointerMove(second.source, { ...touch(), ...at(140) });
    fireEvent.pointerCancel(second.source, { ...touch(), ...at(140) });
    expect(second.spies.onCancel).toHaveBeenCalledTimes(1);
    expect(second.spies.onDrop).not.toHaveBeenCalled();
  });

  it("Escape ending a touch drag swallows the click the browser sends when the finger lifts, however long it stays down", () => {
    const { spies, source } = setup();
    fireEvent.pointerDown(source, { ...touch(), ...at(100) });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    fireEvent.pointerMove(source, { ...touch(), ...at(140) });
    frame();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(spies.onCancel).toHaveBeenCalledTimes(1);
    // An iPad with a keyboard: the finger stays on the glass well past the click window, then lifts a little further on.
    act(() => vi.advanceTimersByTime(SUPPRESS_CLICK_MS * 3));
    fireEvent.pointerMove(source, { ...touch(), ...at(150) });
    fireEvent.pointerUp(source, { ...touch(), ...at(150) });
    fireEvent.click(source, at(150));
    expect(spies.click).not.toHaveBeenCalled();
    expect(spies.onDrop).not.toHaveBeenCalled();
    expect(spies.onTap).not.toHaveBeenCalled();

    // One click only, and only there: the next tap goes through.
    fireEvent.click(source, at(150));
    expect(spies.click).toHaveBeenCalledTimes(1);
  });

  it("Escape on an armed press swallows the click at the release, so the rail sheet does not open; a tap elsewhere still goes through", () => {
    const elsewhere = setup();
    fireEvent.pointerDown(elsewhere.source, { ...touch(), ...at(100) });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(elsewhere.source, { ...touch(), ...at(100) });
    fireEvent.click(elsewhere.source, at(400, 700));
    expect(elsewhere.spies.click).toHaveBeenCalledTimes(1);
    expect(elsewhere.spies.onTap).not.toHaveBeenCalled();
    elsewhere.unmount();

    const again = setup();
    fireEvent.pointerDown(again.source, { ...touch(), ...at(100) });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(again.source, { ...touch(), ...at(100) });
    fireEvent.click(again.source, at(100));
    expect(again.spies.click).not.toHaveBeenCalled();
    expect(again.spies.onTap).not.toHaveBeenCalled();
  });

  it("a second finger ending a drag swallows the click at the first finger's release too", () => {
    const { spies, source, background } = setup();
    fireEvent.pointerDown(source, { ...touch(1), ...at(100) });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    fireEvent.pointerMove(source, { ...touch(1), ...at(140) });
    fireEvent.pointerDown(background, { ...touch(2), ...at(300, 300) });
    expect(spies.onCancel).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(background, { ...touch(2), ...at(300, 300) });
    fireEvent.pointerUp(source, { ...touch(1), ...at(140) });
    fireEvent.click(source, at(140));
    expect(spies.click).not.toHaveBeenCalled();
    expect(spies.onDrop).not.toHaveBeenCalled();
  });

  it("swallows nothing after a pointercancel (no click follows) or an Escape before the press armed (an ordinary click)", () => {
    const { spies, source } = setup();
    fireEvent.pointerDown(source, { ...touch(), ...at(100) });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerCancel(source, { ...touch(), ...at(100) });
    fireEvent.click(source, at(100));
    expect(spies.click).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(source, { ...touch(2), ...at(100) });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS - 100));
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(source, { ...touch(2), ...at(100) });
    fireEvent.click(source, at(100));
    expect(spies.click).toHaveBeenCalledTimes(2);
  });

  it("a pointer already down when the press began does not abort; a new pointerdown in the scroller does", () => {
    const { spies, source, background } = setup();
    fireEvent.pointerDown(background, { ...touch(5), ...at(20, 20) });
    fireEvent.pointerDown(source, { ...touch(1), ...at(100) });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    fireEvent.pointerMove(background, { ...touch(5), ...at(60, 60) });
    fireEvent.pointerUp(background, { ...touch(5), ...at(60, 60) });
    expect(spies.onCancel).not.toHaveBeenCalled();
    fireEvent.pointerDown(background, { ...touch(6), ...at(300, 300) });
    expect(spies.onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("useLongPressDrag — the browser around it", () => {
  it("registers the touchmove guard non-passive at mount; it cancels only while armed or dragging", () => {
    const spy = vi.spyOn(HTMLElement.prototype, "addEventListener");
    const { source, scroller } = setup();
    expect(spy.mock.calls.some(([type, , options]) => type === "touchmove" && (options as AddEventListenerOptions)?.passive === false)).toBe(true);
    spy.mockRestore();

    const idle = new Event("touchmove", { bubbles: true, cancelable: true });
    scroller.dispatchEvent(idle);
    expect(idle.defaultPrevented).toBe(false);

    fireEvent.pointerDown(source, { ...touch(), ...at(100) });
    const pressing = new Event("touchmove", { bubbles: true, cancelable: true });
    scroller.dispatchEvent(pressing);
    expect(pressing.defaultPrevented).toBe(false);

    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    const armed = new Event("touchmove", { bubbles: true, cancelable: true });
    scroller.dispatchEvent(armed);
    expect(armed.defaultPrevented).toBe(true);
  });

  it("prevents the long-press context menu inside the drawing", () => {
    const { source } = setup();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    source.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("works without setPointerCapture (jsdom) and calls it where it exists", () => {
    const { spies, source } = setup();
    expect("setPointerCapture" in source).toBe(false);
    fireEvent.pointerDown(source, { ...touch(), ...at(100) });
    expect(() => act(() => vi.advanceTimersByTime(LONG_PRESS_MS))).not.toThrow();
    expect(spies.onStart).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(source, { ...touch(), ...at(100) });

    const capture = vi.fn();
    Object.defineProperty(source, "setPointerCapture", { value: capture, configurable: true });
    fireEvent.pointerDown(source, { ...touch(), ...at(100) });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    expect(capture).toHaveBeenCalledWith(1);
  });
});
