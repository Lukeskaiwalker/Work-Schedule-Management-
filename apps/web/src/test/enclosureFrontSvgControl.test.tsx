/**
 * The §14a block and the cabinet preparation's leads in the 2D drawing
 * (docs/PANEL_ENCLOSURE_R4.md §5, §8.2): the block is drawn on its AAR rail
 * ("§14a", red when it does not fit), a tap on it opens the §14a sheet —
 * painted last, so it wins over the rail band under it — and the open view
 * draws `prep.runs` dashed (supply ink 2/2, network teal 4/3, control violet
 * 6/4, in screen px at every zoom) with a label at the middle of the longest
 * segment. The closed view draws neither.
 * Invented boards only — the repo is public.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { EnclosureFrontSvg, type EnclosureFrontSvgProps } from "../components/schaltplan/enclosure/EnclosureFrontSvg";
import { RUN_DASH_PX, runLabelPoint } from "../components/schaltplan/enclosure/EnclosureFrontBoxes";
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
    expect(shape.textContent).toBe("§14a");
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
      expect(element.querySelector("text")?.textContent).toBe(run.label);
    }
    expect(RUN_DASH_PX).toEqual({ supply: [2, 2], network: [4, 3], control: [6, 4] });
  });

  it("draws no runs in the closed view", () => {
    const { container } = setup(ehzBoard(), "closed");
    expect(container.querySelectorAll("[data-run]")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /^§14a-Klemmleiste/ })).toBeNull();
  });

  it("puts the label at the middle of the longest segment", () => {
    const run = (points: [number, number][]): PrepRun => ({ kind: "control", from: points[0], to: points[points.length - 1], points, label: "x", lengthMm: 0 });
    expect(runLabelPoint(run([[10, 10], [10, 110], [40, 110]]))).toEqual([10, 60]);
    expect(runLabelPoint(run([[10, 10], [10, 20], [210, 20]]))).toEqual([110, 20]);
    expect(runLabelPoint(run([[5, 5], [5, 5]]))).toEqual([5, 5]);
  });
});
