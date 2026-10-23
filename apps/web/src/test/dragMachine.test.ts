/**
 * The long-press drag gesture as a pure state machine
 * (docs/PANEL_ENCLOSURE_R2.md §6.2, R9): idle → pressing → armed →
 * dragging → idle. Touch and pen arm after a still long-press, a mouse
 * drags after a few px; a short tap AND a long press released without
 * moving are both taps (D16 holds for slow, gloved taps).
 */
import { describe, expect, it } from "vitest";

import {
  autoScrollStep,
  dragStep,
  EDGE_MAX_STEP_PX,
  EDGE_ZONE_PX,
  IDLE_DRAG,
  LONG_PRESS_MS,
  MOUSE_SLOP_PX,
  SLOP_PX,
  type DragInput,
  type DragMachine,
} from "../components/schaltplan/enclosure/dragMachine";

function run(inputs: DragInput[], start: DragMachine = IDLE_DRAG) {
  let state = start;
  const effects: string[] = [];
  for (const input of inputs) {
    const next = dragStep(state, input);
    state = next.state;
    effects.push(next.effect);
  }
  return { state, effects };
}

const down = (pointerType: string, x = 100, y = 100, extra: Partial<Extract<DragInput, { type: "down" }>> = {}): DragInput => ({
  type: "down", pointerId: 1, pointerType, button: 0, point: { x, y }, sourceId: "ls1", ...extra,
});
const move = (x: number, y = 100, pointerId = 1): DragInput => ({ type: "move", pointerId, point: { x, y } });
const up = (x = 100, y = 100, pointerId = 1): DragInput => ({ type: "up", pointerId, point: { x, y } });
const LONG: DragInput = { type: "longpress" };

describe("constants (settled by the W0 spike)", () => {
  it("are the addendum's defaults", () => {
    expect(LONG_PRESS_MS).toBe(450);
    expect(SLOP_PX).toBe(8);
    expect(MOUSE_SLOP_PX).toBe(6);
  });
});

describe("touch and pen", () => {
  it.each(["touch", "pen"])("%s: press schedules the long-press timer; a short tap is an ordinary click", (type) => {
    const { state, effects } = run([down(type), up()]);
    expect(effects).toEqual(["schedule", "none"]);
    expect(state.phase).toBe("idle");
  });

  it("moving past the slop before arming gives the finger back to native scrolling", () => {
    const { state, effects } = run([down("touch"), move(100 + SLOP_PX - 1), move(100 + SLOP_PX + 1), LONG]);
    expect(effects).toEqual(["schedule", "none", "cancel", "none"]);
    expect(state.phase).toBe("idle");
  });

  it("a still long press arms; released without moving it is a tap", () => {
    const { state, effects } = run([down("touch"), move(103, 102), LONG, up(103, 102)]);
    expect(effects).toEqual(["schedule", "none", "arm", "tap"]);
    expect(state.phase).toBe("idle");
  });

  it("after arming, movement past the slop (from where it armed) starts the drag; release drops", () => {
    const { state, effects } = run([down("touch"), move(106), LONG, move(106 + SLOP_PX), move(106 + SLOP_PX + 1), move(200, 180), up(200, 180)]);
    expect(effects).toEqual(["schedule", "none", "arm", "none", "start", "move", "drop"]);
    expect(state.phase).toBe("idle");
  });

  it("remembers the source and the pointer while pressed", () => {
    const { state } = run([down("pen", 10, 20, { pointerId: 7, sourceId: "fi2" }), LONG]);
    expect(state).toMatchObject({ phase: "armed", pointerId: 7, pointerType: "pen", sourceId: "fi2" });
  });
});

describe("mouse", () => {
  it("goes straight to dragging after the mouse slop; a release before it is a click", () => {
    expect(run([down("mouse"), move(100 + MOUSE_SLOP_PX), up()]).effects).toEqual(["none", "none", "none"]);
    const drag = run([down("mouse"), move(100 + MOUSE_SLOP_PX + 1), move(150), up(150)]);
    expect(drag.effects).toEqual(["none", "start", "move", "drop"]);
  });

  it("never arms on a long press and ignores other buttons", () => {
    expect(run([down("mouse"), LONG]).state.phase).toBe("pressing");
    expect(run([down("mouse", 100, 100, { button: 2 })]).state.phase).toBe("idle");
  });
});

describe("what does not start or what aborts", () => {
  it("a press outside a drag source does nothing", () => {
    expect(run([down("touch", 1, 1, { sourceId: null })])).toMatchObject({ state: { phase: "idle" }, effects: ["none"] });
  });

  it("a new pointerdown aborts (a pinch, a second finger) and does not start a press of its own", () => {
    for (const lead of [[down("touch")], [down("touch"), LONG], [down("touch"), LONG, move(140)]]) {
      const { state, effects } = run([...lead, down("touch", 300, 300, { pointerId: 2 })]);
      expect(effects[effects.length - 1]).toBe("cancel");
      expect(state.phase).toBe("idle");
    }
  });

  it("moves and releases of a pointer that was already down are ignored", () => {
    const { state, effects } = run([down("touch"), LONG, move(400, 400, 9), up(400, 400, 9)]);
    expect(effects).toEqual(["schedule", "arm", "none", "none"]);
    expect(state.phase).toBe("armed");
  });

  it("pointercancel and Escape abort in every phase", () => {
    for (const abort of [{ type: "cancel", pointerId: 1 }, { type: "escape" }] as DragInput[]) {
      expect(run([down("touch"), abort]).effects).toEqual(["schedule", "cancel"]);
      expect(run([down("touch"), LONG, abort]).effects).toEqual(["schedule", "arm", "cancel"]);
      expect(run([down("mouse"), move(150), abort]).effects).toEqual(["none", "start", "cancel"]);
    }
    expect(run([{ type: "escape" }]).effects).toEqual(["none"]);
  });
});

describe("edge auto-scroll", () => {
  const rect = { left: 0, top: 100, right: 800, bottom: 600 };

  it("scrolls faster the closer the finger is to an edge, and not at all in the middle", () => {
    expect(autoScrollStep({ x: 400, y: 300 }, rect)).toEqual({ dx: 0, dy: 0 });
    expect(autoScrollStep({ x: 0, y: 300 }, rect)).toEqual({ dx: -EDGE_MAX_STEP_PX, dy: 0 });
    expect(autoScrollStep({ x: 800 - EDGE_ZONE_PX / 2, y: 300 }, rect)).toEqual({ dx: Math.round(EDGE_MAX_STEP_PX / 2), dy: 0 });
    expect(autoScrollStep({ x: 400, y: 100 + EDGE_ZONE_PX }, rect)).toEqual({ dx: 0, dy: 0 });
    expect(autoScrollStep({ x: 400, y: 640 }, rect)).toEqual({ dx: 0, dy: EDGE_MAX_STEP_PX });
  });
});
