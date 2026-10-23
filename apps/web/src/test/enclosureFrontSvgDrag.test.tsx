/**
 * Device drag in the 2D drawing (docs/PANEL_ENCLOSURE_R2.md §6.2, §6.3,
 * §6.7, R9): devices are drag sources only in the Offen view, only with
 * `onMoveDevice` and a `dragSource`, never read-only. A mouse drag over a
 * rail hands `onMoveDevice` the drop; a refused rail drops nothing; a long
 * press released in place still opens the rail. The drawing itself does not
 * re-render while the pointer moves — only the drag layer does.
 *
 * Invented boards only — the repo is public.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const renders = vi.hoisted(() => ({ boxes: 0 }));
vi.mock("../components/schaltplan/enclosure/EnclosureFrontBoxes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/schaltplan/enclosure/EnclosureFrontBoxes")>();
  function CountedBoxShape(props: Parameters<typeof actual.BoxShape>[0]) {
    renders.boxes += 1;
    return <actual.BoxShape {...props} />;
  }
  return { ...actual, BoxShape: CountedBoxShape };
});

import { EnclosureFrontSvg, type EnclosureFrontSvgProps } from "../components/schaltplan/enclosure/EnclosureFrontSvg";
import { LONG_PRESS_MS } from "../components/schaltplan/enclosure/dragMachine";
import { deviceDragSource } from "../components/schaltplan/enclosure/enclosureDropTargets";
import { DRAWING_PAD_PX, FIELD_HEADER_PX } from "../components/schaltplan/enclosure/enclosureFrontLayout";
import { INDEX } from "./enclosureTestCatalog";
import { renderBoard, renderScene } from "./enclosureRenderBoard";

const ZOOM = 0.65;
/** Client px of a cabinet point (jsdom puts the svg at 0, 0). */
const client = (x: number, y: number) => ({ clientX: DRAWING_PAD_PX + x * ZOOM, clientY: FIELD_HEADER_PX + DRAWING_PAD_PX + y * ZOOM });
const mouse = { pointerId: 1, pointerType: "mouse", button: 0 };
const touch = { pointerId: 1, pointerType: "touch", button: 0 };

function setup(overrides: Partial<EnclosureFrontSvgProps> = {}) {
  const doc = renderBoard();
  const props: EnclosureFrontSvgProps = {
    scene: renderScene("open", doc),
    zoom: ZOOM,
    highlightDeviceId: null,
    selectedModuleId: null,
    onOpenRail: vi.fn(),
    onOpenModule: vi.fn(),
    onPickSlot: vi.fn(),
    readOnly: false,
    onMoveDevice: vi.fn(),
    dragSource: (id) => deviceDragSource(doc, INDEX, id),
    ...overrides,
  };
  return { ...render(<EnclosureFrontSvg {...props} />), props };
}

const device = (name: string) => screen.getByRole("button", { name });
const frame = () => act(() => vi.advanceTimersByTime(20));

beforeEach(() => {
  vi.useFakeTimers();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  vi.useRealTimers();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

describe("drag sources", () => {
  it("are the device targets of the Offen view on an editable drawing", () => {
    setup();
    expect(device("Gerät F1.1 auf F2 · Verteiler 1")).toHaveAttribute("data-drag-device", "ls1");
  });

  it.each([
    ["read-only", { readOnly: true }],
    ["without onMoveDevice", { onMoveDevice: undefined }],
    ["without a drag source", { dragSource: undefined }],
  ] as const)("do not exist %s", (_name, overrides) => {
    const { container } = setup(overrides as Partial<EnclosureFrontSvgProps>);
    expect(container.querySelector("[data-drag-device]")).toBeNull();
  });

  it("do not exist in the closed view", () => {
    const { container } = setup({ scene: renderScene("closed") });
    expect(container.querySelector("[data-drag-device]")).toBeNull();
  });
});

describe("dragging a device", () => {
  it("a mouse drag onto another rail hands over the drop", () => {
    const { props } = setup();
    const ls = device("Gerät F1.1 auf F2 · Verteiler 1");
    // Into field 2's empty rail r3 (centre y 400).
    fireEvent.pointerDown(ls, { ...mouse, ...client(373, 100) });
    fireEvent.pointerMove(ls, { ...mouse, ...client(373, 300) });
    frame();
    expect(document.querySelector(".sp-encl-drag-label")).toHaveTextContent("F1.1 LS → F2 · Verteiler 2 · am Anfang");
    fireEvent.pointerMove(ls, { ...mouse, ...client(330, 400) });
    frame();
    fireEvent.pointerUp(ls, { ...mouse, ...client(330, 400) });
    expect(props.onMoveDevice).toHaveBeenCalledTimes(1);
    expect(props.onMoveDevice).toHaveBeenCalledWith("ls1", expect.objectContaining({ moduleId: "m2", railKey: "r3", at: 0, refused: null }));
    expect(document.querySelector(".sp-encl-drag-label")).toBeNull();
    // The click that follows the drag, where it was released, opens nothing.
    fireEvent.click(ls, client(330, 400));
    expect(props.onOpenRail).not.toHaveBeenCalled();
  });

  it("a rail reserved for terminals refuses: nothing is dropped", () => {
    const { props } = setup({ reservedRails: new Set(["m2:r3"]) });
    const ls = device("Gerät F1.1 auf F2 · Verteiler 1");
    fireEvent.pointerDown(ls, { ...mouse, ...client(373, 100) });
    fireEvent.pointerMove(ls, { ...mouse, ...client(330, 400) });
    frame();
    expect(document.querySelector(".sp-encl-drag-label")).toHaveTextContent("Reihenklemmen-Schiene — hier keine Geräte");
    fireEvent.pointerUp(ls, { ...mouse, ...client(330, 400) });
    expect(props.onMoveDevice).not.toHaveBeenCalled();
  });

  it("a device already on a terminal rail opens its rail on a tap and can be dragged off it (§3.6, §4.2)", () => {
    const { props } = setup({ reservedRails: new Set(["m2:r1"]) });
    const ls = device("Gerät F1.1 auf F2 · Verteiler 1");
    expect(ls).toHaveAttribute("data-drag-device", "ls1");
    fireEvent.click(ls, client(373, 100));
    expect(props.onOpenRail).toHaveBeenCalledWith("m2", "r1", "ls1");
    fireEvent.pointerDown(ls, { ...mouse, ...client(373, 100) });
    fireEvent.pointerMove(ls, { ...mouse, ...client(330, 400) });
    frame();
    fireEvent.pointerUp(ls, { ...mouse, ...client(330, 400) });
    expect(props.onMoveDevice).toHaveBeenCalledWith("ls1", expect.objectContaining({ moduleId: "m2", railKey: "r3", refused: null }));
  });

  it("a long press released in place opens the rail, once", () => {
    const { props } = setup();
    const ls = device("Gerät F1.1 auf F2 · Verteiler 1");
    fireEvent.pointerDown(ls, { ...touch, ...client(373, 100) });
    act(() => vi.advanceTimersByTime(700));
    expect(document.querySelector(".sp-encl-drag-label")).toHaveTextContent("F1.1 LS");
    fireEvent.pointerUp(ls, { ...touch, ...client(373, 100) });
    fireEvent.click(ls, client(373, 100));
    expect(props.onOpenRail).toHaveBeenCalledTimes(1);
    expect(props.onOpenRail).toHaveBeenCalledWith("m2", "r1", "ls1");
    expect(props.onMoveDevice).not.toHaveBeenCalled();
  });

  it("does not re-render the drawing while the finger moves", () => {
    setup();
    const ls = device("Gerät F1.1 auf F2 · Verteiler 1");
    fireEvent.pointerDown(ls, { ...touch, ...client(373, 100) });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    const before = renders.boxes;
    for (let y = 110; y < 600; y += 40) {
      fireEvent.pointerMove(ls, { ...touch, ...client(373, y) });
      frame();
    }
    expect(document.querySelector(".sp-encl-drag-label")).not.toBeNull();
    expect(renders.boxes).toBe(before);
  });
});
