/**
 * WAGO terminals in the 2D cabinet drawing (docs/PANEL_ENCLOSURE_R2.md §8,
 * §7.2, §6.2, §14.3 "enclosureFrontSvg"): placed strips are drawn on their
 * terminal rail with their X label, reserved rails are tinted, a tap on a
 * reserved band or a strip opens the close-up, a device on a reserved rail
 * still opens RailSheet, and a strip drags as a whole onto its field's other
 * terminal rail. Paint order: strips above the bands, devices above all.
 *
 * Invented boards only — the repo is public.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { EnclosureFrontSvg, type EnclosureFrontSvgProps } from "../components/schaltplan/enclosure/EnclosureFrontSvg";
import { deviceDragSource, stripDragSource } from "../components/schaltplan/enclosure/enclosureDropTargets";
import { reservedRailLine } from "../components/schaltplan/enclosure/enclosureEditorModel";
import { DRAWING_PAD_PX, FIELD_HEADER_PX } from "../components/schaltplan/enclosure/enclosureFrontLayout";
import { buildEnclosureScene } from "../utils/enclosureGeometry";
import { placeTerminals, terminalRailKeys } from "../utils/enclosureTerminals";
import type { PanelDocument } from "../types/schaltplan";
import { dev, doc, fi, lsRun, mod, range, row } from "./enclosureTerminalBoards";
import { INDEX } from "./enclosureTestCatalog";

const ZOOM = 0.65;
const client = (x: number, y: number) => ({ clientX: DRAWING_PAD_PX + x * ZOOM, clientY: FIELD_HEADER_PX + DRAWING_PAD_PX + y * ZOOM });
const mouse = { pointerId: 1, pointerType: "mouse", button: 0 };

/** ZB33S. Feld 1: r1 holds a breaker left from before (reserved), groups F1–F3 on r3–r5 → X1–X3. Feld 2: F4 on r3 → X4. */
function terminalBoard(): PanelDocument {
  const group = (g: number, count: number, first: number) => [fi(`dev-f${g}`, `F${g}`), ...lsRun(`f${g}`, `F${g}`, range(1, count + 1), first)];
  return doc("ZB33S", [
    mod("mod-a", "ZU37KS", 0, { r1: "row-a1", r3: "row-a3", r4: "row-a4", r5: "row-a5" }),
    mod("mod-b", "ZU37KS", 1, { r3: "row-b3" }),
  ], [
    row("row-a1", "F1 · Verteiler 1", [dev("old1", "mcb", { designation: "Q9" })]),
    row("row-a3", "F1 · Verteiler 3", group(1, 8, 1)),
    row("row-a4", "F1 · Verteiler 4", group(2, 8, 9)),
    row("row-a5", "F1 · Verteiler 5", group(3, 8, 17)),
    row("row-b3", "F2 · Verteiler 3", group(4, 2, 25)),
  ]);
}

function setup(overrides: Partial<EnclosureFrontSvgProps> = {}, view: "open" | "closed" = "open") {
  const board = terminalBoard();
  const placement = placeTerminals(board, INDEX);
  const scene = buildEnclosureScene(board, INDEX, view, placement)!;
  const props: EnclosureFrontSvgProps = {
    scene,
    zoom: ZOOM,
    highlightDeviceId: null,
    selectedModuleId: null,
    onOpenRail: vi.fn(),
    onOpenModule: vi.fn(),
    onPickSlot: vi.fn(),
    readOnly: false,
    reservedRails: terminalRailKeys(board, INDEX),
    placement,
    onOpenTerminals: vi.fn(),
    onMoveDevice: vi.fn(),
    dragSource: (id) => deviceDragSource(board, INDEX, id),
    onMoveStrip: vi.fn(),
    stripSource: (id) => stripDragSource(board, INDEX, placement, id),
    ...overrides,
  };
  return { ...render(<EnclosureFrontSvg {...props} />), props, scene, placement };
}

beforeEach(() => {
  vi.useFakeTimers();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  vi.useRealTimers();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

describe("the picture", () => {
  it("draws every placed strip on its rail with its X label, and tints the reserved rails", () => {
    const { container, placement } = setup();
    const strips = placement.fields.flatMap((field) => field.rails.flatMap((rail) => rail.strips));
    const shapes = container.querySelectorAll('.sp-encl-picture [data-kind="terminal_strip"]');
    expect(shapes).toHaveLength(strips.length);
    expect(container.querySelector('[data-box-id="terminal:dev-f1:leiste"]')).not.toBeNull();
    // Labels are a pass of their own, after the boxes (and the leads).
    expect(container.querySelector('.sp-encl-labels [data-label-for="terminal:dev-f1:leiste"]')).toHaveTextContent("X1");
    for (const railKey of ["r1", "r2"]) {
      expect(container.querySelector(`[data-box-id="rail:mod-a:${railKey}"]`)).toHaveClass("sp-encl-rail--terminals");
    }
    expect(container.querySelector('[data-box-id="rail:mod-a:r3"]')).not.toHaveClass("sp-encl-rail--terminals");
  });

  it("draws no strips in the closed view (they sit behind the cover)", () => {
    const { container } = setup({}, "closed");
    expect(container.querySelector('[data-kind="terminal_strip"]')).toBeNull();
    expect(container.querySelector('[data-target="strip"]')).toBeNull();
  });
});

describe("taps", () => {
  it("a reserved band opens the close-up of its field; a strip opens it with the strip selected", () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole("button", { name: /^Hutschiene F1 · Verteiler 2 · für Reihenklemmen/ }));
    expect(props.onOpenTerminals).toHaveBeenCalledWith(0, null);
    fireEvent.click(screen.getByRole("button", { name: "Klemmleiste X1 auf F1 · Verteiler 1" }));
    expect(props.onOpenTerminals).toHaveBeenLastCalledWith(0, "dev-f1:leiste");
    expect(props.onOpenRail).not.toHaveBeenCalled();
  });

  it("names what a reserved band holds — its strips and any old devices — instead of calling it empty", () => {
    const { placement } = setup();
    const xOn = (moduleId: string, railKey: string) =>
      placement.fields.flatMap((field) => field.rails).find((rail) => rail.moduleId === moduleId && rail.railKey === railKey)!.strips.map((strip) => strip.xLabel);
    expect(xOn("mod-a", "r1").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: `Hutschiene F1 · Verteiler 1 · ${reservedRailLine(xOn("mod-a", "r1"))} · 1 Gerät` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hutschiene F2 · Verteiler 1 · für Reihenklemmen reserviert · X4" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hutschiene F2 · Verteiler 2 · für Reihenklemmen reserviert · noch keine" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hutschiene F1 · Verteiler 3 · 9 Geräte" })).toBeInTheDocument();
  });

  it("a device on a reserved rail still opens its RailSheet", () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Gerät Q9 auf F1 · Verteiler 1" }));
    expect(props.onOpenRail).toHaveBeenCalledWith("mod-a", "r1", "old1");
  });

  it("without onOpenTerminals a reserved band opens the rail, and strips are no targets", () => {
    const { container, props } = setup({ onOpenTerminals: undefined });
    expect(container.querySelector('[data-target="strip"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Hutschiene F1 · Verteiler 2/ }));
    expect(props.onOpenRail).toHaveBeenCalledWith("mod-a", "r2", null);
  });
});

describe("hit layer order", () => {
  it("paints strips over the rail bands and devices over the strips", () => {
    const { container } = setup();
    const targets = (kind: string) => Array.from(container.querySelectorAll(`.sp-encl-hits [data-target="${kind}"]`));
    const after = (later: Element[], earlier: Element[]) =>
      later.every((element) => earlier.every((before) => (before.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0));
    const [rails, strips, devices] = ["rail", "strip", "device"].map(targets);
    expect(strips.length).toBeGreaterThan(0);
    expect(after(strips, rails)).toBe(true);
    expect(after(devices, strips)).toBe(true);
    expect(container.querySelector(".sp-encl-hits")!.lastElementChild).toHaveAttribute("data-target", "device");
  });
});

describe("strip drag", () => {
  const stripTarget = () => screen.getByRole("button", { name: "Klemmleiste X1 auf F1 · Verteiler 1" });

  it("moves a whole strip onto its field's other terminal rail", () => {
    const { props, scene } = setup();
    const source = scene.boxes.find((box) => box.id === "terminal:dev-f1:leiste")!;
    const rail2 = scene.boxes.find((box) => box.id === "rail:mod-a:r2")!;
    expect(stripTarget()).toHaveAttribute("data-drag-device", "terminal:dev-f1:leiste");
    fireEvent.pointerDown(stripTarget(), { ...mouse, ...client(source.x + 5, source.y + source.h / 2) });
    fireEvent.pointerMove(stripTarget(), { ...mouse, ...client(rail2.x + 2, rail2.y + rail2.h / 2) });
    act(() => vi.advanceTimersByTime(20));
    expect(document.querySelector(".sp-encl-drag-label")).toHaveTextContent("X1 → Hutschiene 2 · Platz 1");
    fireEvent.pointerUp(stripTarget(), { ...mouse, ...client(rail2.x + 2, rail2.y + rail2.h / 2) });
    expect(props.onMoveStrip).toHaveBeenCalledWith("dev-f1:leiste", expect.objectContaining({ field: 0, rail: 1, at: 0, refused: null }));
  });

  it("drops nothing on a rail that is no terminal rail or belongs to another field", () => {
    const { props, scene } = setup();
    const source = scene.boxes.find((box) => box.id === "terminal:dev-f1:leiste")!;
    for (const id of ["rail:mod-a:r4", "rail:mod-b:r1"]) {
      const rail = scene.boxes.find((box) => box.id === id)!;
      fireEvent.pointerDown(stripTarget(), { ...mouse, ...client(source.x + 5, source.y + source.h / 2) });
      fireEvent.pointerMove(stripTarget(), { ...mouse, ...client(rail.x + 20, rail.y + rail.h / 2) });
      act(() => vi.advanceTimersByTime(20));
      fireEvent.pointerUp(stripTarget(), { ...mouse, ...client(rail.x + 20, rail.y + rail.h / 2) });
    }
    expect(props.onMoveStrip).not.toHaveBeenCalled();
  });

  it("offers no strip drag on a read-only drawing or without onMoveStrip", () => {
    const { container, unmount } = setup({ onMoveStrip: undefined });
    expect(container.querySelector('[data-drag-device^="terminal:"]')).toBeNull();
    unmount();
    const readOnly = setup({ readOnly: true });
    expect(readOnly.container.querySelector("[data-drag-device]")).toBeNull();
  });
});
