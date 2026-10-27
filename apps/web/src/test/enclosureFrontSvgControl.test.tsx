/**
 * The §14a block and the cabinet preparation's leads in the 2D drawing
 * (docs/PANEL_ENCLOSURE_R4.md §5, §8.2): the block is drawn on its AAR rail
 * ("§14a", red when it does not fit), a tap on it opens the §14a sheet —
 * painted last, so it wins over the rail band under it — and the open view
 * draws `prep.runs` dashed (supply ink 2/2, network teal 4/3, control violet
 * 6/4, in screen px at every zoom) under every box label (labels are a
 * pass of their own, on a halo), the run labels last, placed off the box
 * labels and inside the drawing. The closed view draws neither.
 * Invented boards only — the repo is public.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { EnclosureFrontSvg, type EnclosureFrontSvgProps } from "../components/schaltplan/enclosure/EnclosureFrontSvg";
import { RUN_DASH_PX } from "../components/schaltplan/enclosure/EnclosureRuns";
import { labelObstacles, runLabelSpot, textWidthPx, type LabelRect } from "../components/schaltplan/enclosure/enclosureRunLabels";
import { defaultControlBlock } from "../utils/enclosureControlBlock";
import { buildEnclosureScene } from "../utils/enclosureGeometry";
import { cabinetPrep } from "../utils/enclosurePrep";
import type { EnclosureModule, PrepRun } from "../types/panelEnclosure";
import type { PanelDocument, PanelRow } from "../types/schaltplan";
import { board, dev, INDEX, row } from "./enclosureTestCatalog";

const ZOOM = 0.45;

const mod = (id: string, code: string, field: number, rails: Record<string, string> = {}): EnclosureModule => ({
  id, code, field, unit: 0, label: "", rails, fittings: null, removed_fittings: [], meters: [],
});

function ehzBoard(rows: PanelRow[] = [], rails: Record<string, string> = {}): PanelDocument {
  const doc = board(rows, { code: "ZB33S", modules: [mod("m1", "ZH3EH16", 0, rails), mod("m2", "ZU37VT5APZ2", 1)] });
  return { ...doc, enclosure: { ...doc.enclosure!, control_block: defaultControlBlock() } };
}

function setup(document: PanelDocument = ehzBoard(), view: "open" | "closed" = "open", overrides: Partial<EnclosureFrontSvgProps> = {}) {
  const scene = buildEnclosureScene(document, INDEX, view)!;
  const runs = cabinetPrep(document, INDEX)!.runs;
  const onOpenControl = vi.fn();
  const props: EnclosureFrontSvgProps = {
    scene,
    zoom: ZOOM,
    highlightDeviceId: null,
    selectedModuleId: null,
    onOpenRail: vi.fn(),
    onOpenModule: vi.fn(),
    readOnly: false,
    runs,
    onOpenControl,
    controlTerminals: 6,
    ...overrides,
  };
  return { ...render(<EnclosureFrontSvg {...props} />), runs, onOpenControl, scene };
}

const fullRow = (id: string) => row(id, Array.from({ length: 12 }, () => dev("mcb")));

describe("the §14a block in the drawing", () => {
  it("draws the block with its label on the carrier's AAR rail", () => {
    const { container, scene } = setup();
    const box = scene.boxes.find((entry) => entry.kind === "control_block")!;
    const shape = container.querySelector(`.sp-encl-picture [data-box-id="control:block"]`)!;
    expect(shape).toHaveAttribute("data-kind", "control_block");
    expect(shape).toHaveClass("sp-encl-control-block");
    expect(shape.querySelector("rect")).toHaveAttribute("width", String(box.w));
    expect(container.querySelector('.sp-encl-labels [data-label-for="control:block"]')?.textContent).toBe("§14a");
  });

  it("marks a block that does not fit", () => {
    const { container } = setup(ehzBoard([fullRow("r1"), fullRow("r2")], { aar1: "r1", aar2: "r2" }));
    expect(container.querySelector(`[data-box-id="control:block"]`)).toHaveClass("sp-encl-control-block--overflow");
  });

  it("opens the §14a sheet on a tap, painted last so it wins over the rail band", () => {
    const { container, onOpenControl } = setup();
    const target = screen.getByRole("button", { name: "§14a-Klemmleiste, Feld 1, 6 Klemmen" });
    expect(target).toHaveAttribute("data-target", "control");
    expect(container.querySelector(".sp-encl-hits")!.lastElementChild).toBe(target);
    fireEvent.click(target);
    expect(onOpenControl).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(target, { key: "Enter" });
    expect(onOpenControl).toHaveBeenCalledTimes(2);
  });

  it("has no block target without a handler", () => {
    setup(ehzBoard(), "open", { onOpenControl: undefined });
    expect(screen.queryByRole("button", { name: /^§14a-Klemmleiste/ })).toBeNull();
  });
});

describe("the leads (prep.runs)", () => {
  it("draws every run dashed in its colour, at screen-px dashes", () => {
    const { container, runs } = setup();
    expect(runs.map((run) => run.kind)).toEqual(["supply", "supply", "network", "control"]);
    const drawn = Array.from(container.querySelectorAll(".sp-encl-picture [data-run]"));
    expect(drawn.map((element) => element.getAttribute("data-run"))).toEqual(["supply", "supply", "network", "control"]);
    for (const [i, element] of drawn.entries()) {
      const run = runs[i];
      expect(element).toHaveClass(`sp-encl-run--${run.kind}`);
      const line = element.querySelector("polyline")!;
      expect(line).toHaveAttribute("points", run.points.map(([x, y]) => `${x},${y}`).join(" "));
      const [dash, gap] = RUN_DASH_PX[run.kind];
      expect(line).toHaveAttribute("stroke-dasharray", `${dash / ZOOM} ${gap / ZOOM}`);
    }
    const labels = Array.from(container.querySelectorAll(".sp-encl-picture [data-run-label]"));
    expect(labels.map((label) => [label.getAttribute("data-run-label"), label.textContent])).toEqual(runs.map((run) => [run.kind, run.label]));
    expect(RUN_DASH_PX).toEqual({ supply: [2, 2], network: [4, 3], control: [6, 4] });
  });

  it("draws no runs in the closed view", () => {
    const { container } = setup(ehzBoard(), "closed");
    expect(container.querySelectorAll("[data-run]")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /^§14a-Klemmleiste/ })).toBeNull();
  });

  it("draws the leads after the boxes and before every box label, the run labels last", () => {
    const { container } = setup();
    const picture = container.querySelector(".sp-encl-picture")!;
    const order = Array.from(picture.children).map((child) => child.getAttribute("class"));
    expect(order.indexOf("sp-encl-runs")).toBeLessThan(order.indexOf("sp-encl-labels"));
    expect(order.indexOf("sp-encl-labels")).toBeLessThan(order.indexOf("sp-encl-run-labels"));
    expect(order[order.length - 1]).toBe("sp-encl-run-labels");
    for (const label of Array.from(container.querySelectorAll('.sp-encl-labels [data-label-for^="rail:"], .sp-encl-labels [data-label-for="control:block"]'))) {
      expect(label).toHaveClass("sp-encl-text--halo");
    }
    // Without leads (closed view) no halo.
    const closed = setup(ehzBoard(), "closed").container;
    expect(closed.querySelectorAll(".sp-encl-text--halo")).toHaveLength(0);
  });
});

describe("runLabelSpot — the PDF's placement, kept inside the drawing", () => {
  const run = (points: [number, number][], label = "x"): PrepRun => ({ kind: "supply", from: points[0], to: points[points.length - 1], points, label, lengthMm: 0 });
  const BOUNDS: LabelRect = [-20, -20, 820, 1120];
  const inside = (rect: LabelRect) => rect[0] >= BOUNDS[0] - 1e-9 && rect[1] >= BOUNDS[1] - 1e-9 && rect[2] <= BOUNDS[2] + 1e-9 && rect[3] <= BOUNDS[3] + 1e-9;
  const overlaps = (a: LabelRect, b: LabelRect) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

  it("turns the label on a vertical segment near the left edge and keeps it inside the drawing", () => {
    const label = "ZY5N2SA · SABO 1,6 A → Zählerplatz";
    const meter: LabelRect = [30, 350, 130, 650];
    const spot = runLabelSpot(run([[20, 700], [20, 300], [60, 300]], label), [meter], 11, 0.45, BOUNDS)!;
    expect(spot.vertical).toBe(true);
    expect(inside(spot.rect)).toBe(true);
    expect(overlaps(spot.rect, meter)).toBe(false);
  });

  it("slides a long horizontal label back inside at the right edge", () => {
    const spot = runLabelSpot(run([[700, 100], [815, 100]], "ZZ45WAN100 · RJ45 · lang"), [], 11, 1, BOUNDS)!;
    expect(spot.vertical).toBe(false);
    expect(inside(spot.rect)).toBe(true);
    expect(spot.rect[2] - spot.rect[0]).toBeCloseTo(textWidthPx("ZZ45WAN100 · RJ45 · lang", 11), 6);
  });

  it("moves off a box label to the next stop, longest segment first", () => {
    const blocker: LabelRect = [190, 0, 230, 120]; // over the middle of the long segment
    const spot = runLabelSpot(run([[10, 100], [410, 100]], "abc"), [blocker], 11, 1, BOUNDS)!;
    expect(spot.x).toBeCloseTo(130, 6); // stop 0,3
    expect(runLabelSpot(run([[5, 5], [5, 5]], ""), [], 11, 1, BOUNDS)).toBeNull();
  });

  it("moves the eHZ board's network label off the rail name its old midpoint sat on", () => {
    const { scene, runs } = setup();
    const shown = scene.boxes.filter((box) => box.kind !== "shell" && box.kind !== "field");
    // The old midpoint (400, 400) is the centre of a rail's name (the browser's "F2 · RfZ").
    const rail = shown.find((box) => box.kind === "rail" && box.x <= 400 && box.x + box.w >= 400 && box.y <= 400 && box.y + box.h >= 400)!;
    const [name] = labelObstacles([rail], new Set([rail.id]), 11, ZOOM, { zoneStripMm: 30, insetMm: 4 / ZOOM });
    expect(name[0] < 400 && name[2] > 400 && name[1] < 400 && name[3] > 400).toBe(true);
    const network = runs.find((entry) => entry.kind === "network")!;
    const spot = runLabelSpot(network, [name], 11, ZOOM, [-40, -40, scene.width + 40, scene.height + 40])!;
    expect(overlaps(spot.rect, name)).toBe(false);
    // With every rail of this empty board named, no stop is clear: the least-covering one is taken.
    const all = labelObstacles(shown, new Set(shown.filter((box) => box.kind === "rail").map((box) => box.id)), 11, ZOOM, { zoneStripMm: 30, insetMm: 4 / ZOOM });
    expect(runLabelSpot(network, all, 11, ZOOM, [-40, -40, scene.width + 40, scene.height + 40])).not.toBeNull();
  });
});
