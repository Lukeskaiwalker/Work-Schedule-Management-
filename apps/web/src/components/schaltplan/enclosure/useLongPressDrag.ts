/**
 * The long-press drag of the Schrank drawing, on Pointer Events
 * (docs/PANEL_ENCLOSURE_R2.md §6.1, §6.2, §6.6). The rules live in the pure
 * `dragMachine`; this hook only wires the browser to it and carries out the
 * effects:
 *
 *  - pointerdown on the scroll container starts a press on the element
 *    carrying `data-drag-device` (only while `enabled`); any other
 *    pointerdown while a press runs aborts it (a pinch, a second finger);
 *  - move / up / cancel / Escape are heard on the window while a press
 *    runs, and only for the pressing pointer — a thumb resting on the glass
 *    is ignored;
 *  - arming captures the pointer (where `setPointerCapture` exists),
 *    vibrates (where `navigator.vibrate` exists; not on iPadOS) and shows
 *    the ghost and the label at once (`onStart`), so a wrong pick can be
 *    released in place;
 *  - pointer moves land in a ref; one animation frame hands the latest
 *    point to `onMove`, and while dragging the same frame scrolls near the
 *    visible edges (`dragAutoScroll`): the container by its own zones, else
 *    an ancestor that scrolls that way (a sheet's body, `main.content`) or
 *    the page by theirs, only while the drawing still runs beyond their
 *    edge — never the page behind a fixed sheet;
 *  - a long press released in place is a tap, and the hook says so itself
 *    (`onTap`): browsers differ on whether a click follows a long press,
 *    and Mobile Safari DOES send one, ~40 ms after the release (W0 spike).
 *    That click — and the one a browser sends after a drop — is swallowed
 *    on the window: one click, within `SUPPRESS_CLICK_MS` and
 *    `SUPPRESS_CLICK_RADIUS_PX` of the release point, so the rail opens
 *    exactly once and a deliberate tap elsewhere (Rückgängig right after a
 *    wrong drop) still goes through;
 *  - a shown drag that Escape (an iPad keyboard) or a second finger ends
 *    leaves its pointer down: the hook keeps listening for that pointer's
 *    release and swallows the click that follows it the same way, so the
 *    cancelled drag does not open the rail sheet at finger-up. A
 *    pointercancel sends no click, and a press cancelled before it armed
 *    was never shown: its release stays an ordinary click.
 *
 * The iPad technique, taken from dnd-kit's TouchSensor: ONE non-passive
 * `touchmove` listener, registered on the container at mount, calls
 * `preventDefault()` only while a drag is armed or running. Safari and
 * Chrome honour that only from a listener that was non-passive before the
 * gesture began; `.sp-encl-scroll` keeps `touch-action: manipulation`, so a
 * finger that moves before the long press still scrolls natively. Nothing
 * here prevents a default outside an armed or running drag, so page
 * scrolling and zoom stay with the user.
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import { autoScroll, scrollFrameOf, type ScrollFrame } from "./dragAutoScroll";
import {
  dragStep,
  IDLE_DRAG,
  LONG_PRESS_MS,
  SUPPRESS_CLICK_MS,
  SUPPRESS_CLICK_RADIUS_PX,
  type DragInput,
  type DragMachine,
  type Point,
} from "./dragMachine";

/** The attribute a drag source carries: the device id. */
export const DRAG_SOURCE_ATTRIBUTE = "data-drag-device";

export interface LongPressDragHandlers {
  /** A press armed (touch, pen) or a mouse began to drag: show the ghost and the label now. */
  onStart: (sourceId: string, point: Point) => void;
  /** The pointer moved while dragging, or the container scrolled under it (once per frame). */
  onMove: (point: Point) => void;
  /** Released while dragging. */
  onDrop: (point: Point) => void;
  /** The ghost goes: aborted (Escape, pointercancel, a new pointer) or released as a tap. */
  onCancel: () => void;
  /**
   * A long press released without moving: the tap the user meant (RailSheet).
   * `target`: the element the press began on, inside the source — a strip's
   * tap can select the terminal under the finger, as a quick tap would.
   */
  onTap: (sourceId: string, target: Element | null) => void;
}

export interface LongPressDragOptions extends LongPressDragHandlers {
  /** The drawing's scroll container: where presses start, where the touchmove guard sits, what auto-scrolls. */
  scrollRef: RefObject<HTMLElement>;
  enabled: boolean;
}

const VIBRATE_MS = 15;

function sourceOf(target: EventTarget | null): Element | null {
  return target instanceof Element ? target.closest(`[${DRAG_SOURCE_ATTRIBUTE}]`) : null;
}

function capture(element: Element | null, pointerId: number | null) {
  if (!element || pointerId === null || typeof (element as Element & { setPointerCapture?: unknown }).setPointerCapture !== "function") return;
  try {
    element.setPointerCapture(pointerId);
  } catch {
    // The pointer is already gone (released between the timer and now): nothing to capture.
  }
}

function vibrate() {
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(VIBRATE_MS);
}

export function useLongPressDrag(options: LongPressDragOptions): void {
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });
  const { scrollRef } = options;

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return undefined;
    let machine: DragMachine = IDLE_DRAG;
    let timer: number | null = null;
    let frame: number | null = null;
    let pendingMove = false;
    let suppress: { until: number; at: Point } | null = null;
    /** A pointer whose shown drag was cancelled while it stayed down: its release arms `suppress`. */
    let releasing: number | null = null;
    let source: Element | null = null;
    let pressed: Element | null = null;
    let scrollFrame: ScrollFrame | null = null;
    let shown = false;

    const clearTimer = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const stopFrame = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      pendingMove = false;
    };
    const hide = () => {
      if (!shown) return;
      shown = false;
      latest.current.onCancel();
    };
    const show = () => {
      if (shown || machine.sourceId === null || machine.last === null) return;
      shown = true;
      scrollFrame = scrollFrameOf(element);
      capture(source, machine.pointerId);
      latest.current.onStart(machine.sourceId, machine.last);
    };

    const tick = () => {
      frame = null;
      if (machine.phase !== "dragging" || machine.last === null) return;
      const scrolled = autoScroll(element, machine.last, scrollFrame ?? scrollFrameOf(element));
      if (pendingMove || scrolled) latest.current.onMove(machine.last);
      pendingMove = false;
      if (scrolled) frame = window.requestAnimationFrame(tick);
    };
    const queueMove = () => {
      pendingMove = true;
      if (frame === null) frame = window.requestAnimationFrame(tick);
    };

    const suppressClickAt = (at: Point) => {
      suppress = { until: Date.now() + SUPPRESS_CLICK_MS, at };
    };

    const onWindowMove = (event: PointerEvent) => apply({ type: "move", pointerId: event.pointerId, point: { x: event.clientX, y: event.clientY } });
    const onWindowUp = (event: PointerEvent) => {
      const point = { x: event.clientX, y: event.clientY };
      if (event.pointerId === releasing) {
        releasing = null;
        suppressClickAt(point);
      }
      apply({ type: "up", pointerId: event.pointerId, point });
    };
    const onWindowCancel = (event: PointerEvent) => {
      // The browser took the pointer: no click follows.
      if (event.pointerId === releasing) releasing = null;
      apply({ type: "cancel", pointerId: event.pointerId });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || machine.phase === "idle") return;
      // Ours, not the sheet stack's: Escape ends the drag and closes nothing else.
      event.preventDefault();
      apply({ type: "escape" });
    };
    let listening = false;
    const listen = (on: boolean) => {
      if (on === listening) return;
      listening = on;
      const method = on ? window.addEventListener : window.removeEventListener;
      method("pointermove", onWindowMove as EventListener);
      method("pointerup", onWindowUp as EventListener);
      method("pointercancel", onWindowCancel as EventListener);
      method("keydown", onKeyDown as EventListener, true);
    };

    function apply(input: DragInput) {
      const before = machine;
      const { state, effect } = dragStep(before, input);
      machine = state;
      if (state.phase !== "pressing") clearTimer();
      if (effect === "cancel" && shown && (input.type === "escape" || input.type === "down")) releasing = before.pointerId;
      listen(state.phase !== "idle" || releasing !== null);
      if (state.phase === "idle") stopFrame();
      switch (effect) {
        case "schedule":
          timer = window.setTimeout(() => apply({ type: "longpress" }), LONG_PRESS_MS);
          break;
        case "arm":
          vibrate();
          show();
          break;
        case "start":
          show();
          queueMove();
          break;
        case "move":
          queueMove();
          break;
        case "drop":
          shown = false;
          if (input.type === "up") {
            suppressClickAt(input.point);
            latest.current.onDrop(input.point);
          }
          break;
        case "tap":
          hide();
          if (input.type === "up") suppressClickAt(input.point);
          if (before.sourceId !== null) latest.current.onTap(before.sourceId, pressed);
          break;
        case "cancel":
          hide();
          break;
        default:
          break;
      }
      if (state.phase === "idle") {
        source = null;
        pressed = null;
        scrollFrame = null;
      }
    }

    const onPointerDown = (event: PointerEvent) => {
      // The same pointer down again: its release after the cancel was missed, so nothing is left to swallow.
      if (event.pointerId === releasing) {
        releasing = null;
        listen(machine.phase !== "idle");
      }
      if (!latest.current.enabled && machine.phase === "idle") return;
      const target = machine.phase === "idle" ? sourceOf(event.target) : null;
      apply({
        type: "down",
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        button: event.button,
        point: { x: event.clientX, y: event.clientY },
        sourceId: target?.getAttribute(DRAG_SOURCE_ATTRIBUTE) ?? null,
      });
      if (machine.phase !== "idle") {
        source = target;
        pressed = target && event.target instanceof Element ? event.target : null;
      }
    };
    const onTouchMove = (event: TouchEvent) => {
      if (machine.phase === "armed" || machine.phase === "dragging") event.preventDefault();
    };
    const onContextMenu = (event: MouseEvent) => {
      if (latest.current.enabled && event.target instanceof Element && event.target.closest("svg")) event.preventDefault();
    };
    const onClickCapture = (event: MouseEvent) => {
      const pending = suppress;
      if (!pending || Date.now() >= pending.until) return;
      if (Math.hypot(event.clientX - pending.at.x, event.clientY - pending.at.y) > SUPPRESS_CLICK_RADIUS_PX) return;
      suppress = null;
      event.preventDefault();
      event.stopPropagation();
    };

    element.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("touchmove", onTouchMove, { passive: false });
    element.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("click", onClickCapture, true);
    return () => {
      clearTimer();
      stopFrame();
      listen(false);
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("touchmove", onTouchMove);
      element.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("click", onClickCapture, true);
    };
  }, [scrollRef]);
}
