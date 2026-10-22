/**
 * The 2D cabinet drawing (docs/PANEL_ENCLOSURE.md §11, §14
 * "enclosureFrontSvg"): ONE tap rule at every zoom — a tap anywhere in a
 * rail band opens that rail (RailSheet) with the tapped device, a tap on a
 * module's background opens the module, a tap on a free unit picks that
 * unit — and nothing in the drawing is a "+". Installers wear gloves; a
 * 1-TE breaker is 3.5 px at the smallest step, so the drawing must route the
 * same tap the same way no matter how big it is drawn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { EnclosureFrontSvg, type EnclosureFrontSvgProps } from "../components/schaltplan/enclosure/EnclosureFrontSvg";
import { ENCLOSURE_ZOOM_STEPS, MIN_LABEL_BOX_PX, railBands } from "../components/schaltplan/enclosure/enclosureFrontLayout";
import { MODULE_WIDTH_MM } from "../utils/schaltplanStrip";
import type { EnclosureScene } from "../types/panelEnclosure";
import { METER_A, METER_B, renderScene } from "./enclosureRenderBoard";

function setup(overrides: Partial<EnclosureFrontSvgProps> = {}, scene: EnclosureScene = renderScene()) {
  const props: EnclosureFrontSvgProps = {
    scene,
    zoom: 0.65,
    highlightDeviceId: null,
    selectedModuleId: null,
    onOpenRail: vi.fn(),
    onOpenModule: vi.fn(),
    onPickSlot: vi.fn(),
    readOnly: false,
    ...overrides,
  };
  const view = render(<EnclosureFrontSvg {...props} />);
  return { ...view, props };
}

const scrollIntoView = vi.fn();
beforeEach(() => {
  scrollIntoView.mockReset();
  Element.prototype.scrollIntoView = scrollIntoView;
});
afterEach(() => {
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

/** On-screen px of a target's width: its width in mm × the svg's px per viewBox unit. */
function drawnWidthPx(svg: SVGSVGElement, target: Element): number {
  const viewWidth = Number(svg.getAttribute("viewBox")!.split(" ")[2]);
  return (Number(target.getAttribute("width")) * Number(svg.getAttribute("width"))) / viewWidth;
}

describe("one tap rule", () => {
  it.each([...ENCLOSURE_ZOOM_STEPS])("at zoom %s a tap on a 1-TE LS and on a 4-TE FI opens their rail with the device", (zoom) => {
    const { props, container } = setup({ zoom });
    const ls = screen.getByRole("button", { name: "Gerät F1.1 auf F2 · Verteiler 1" });
    // The target is drawn as small as the breaker (3.5 px at the smallest step) and still routes the tap.
    expect(drawnWidthPx(container.querySelector("svg")!, ls)).toBeCloseTo(MODULE_WIDTH_MM * zoom, 5);
    if (zoom === ENCLOSURE_ZOOM_STEPS[0]) expect(drawnWidthPx(container.querySelector("svg")!, ls)).toBeLessThan(MIN_LABEL_BOX_PX);
    fireEvent.click(ls);
    expect(props.onOpenRail).toHaveBeenLastCalledWith("m2", "r1", "ls1");
    fireEvent.click(screen.getByRole("button", { name: "Gerät F1 auf F2 · Verteiler 1" }));
    expect(props.onOpenRail).toHaveBeenLastCalledWith("m2", "r1", "fi1");
    expect(props.onOpenRail).toHaveBeenCalledTimes(2);
    expect(props.onOpenModule).not.toHaveBeenCalled();
  });

  it("a tap in the rail band beside the devices opens the rail without a device", () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Hutschiene F2 · Verteiler 1 · 2 Geräte" }));
    expect(props.onOpenRail).toHaveBeenCalledWith("m2", "r1", null);
  });

  it("an empty rail without a row is a target too", () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Hutschiene F2 · Verteiler 2 · leer" }));
    expect(props.onOpenRail).toHaveBeenCalledWith("m2", "r2", null);
  });

  it("a pre-fitted device says so and still opens its rail", () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Gerät Q1 auf F1 · AAR 1 · vorbestückt" }));
    expect(props.onOpenRail).toHaveBeenCalledWith("m1", "aar1", "hs1");
  });

  it("a tap on the module background opens the module", () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Modul ZH3EH16 in Feld 1" }));
    expect(props.onOpenModule).toHaveBeenCalledWith("m1");
    fireEvent.click(screen.getByRole("button", { name: "Modul ZU62A in Feld 4" }));
    expect(props.onOpenModule).toHaveBeenLastCalledWith("m4");
    expect(props.onOpenRail).not.toHaveBeenCalled();
  });

  it("a tap on a free unit picks that field and unit", () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Freier Platz in Feld 4, Höhe 5 von 7 — Modul wählen" }));
    expect(props.onPickSlot).toHaveBeenCalledWith(3, 4);
    fireEvent.click(screen.getByRole("button", { name: "Freier Platz in Feld 5, Höhe 1 von 7 — Modul wählen" }));
    expect(props.onPickSlot).toHaveBeenLastCalledWith(4, 0);
  });

  it("Enter and Space activate a target, like a button", () => {
    const { props } = setup();
    fireEvent.keyDown(screen.getByRole("button", { name: "Modul ZU37KS in Feld 2" }), { key: "Enter" });
    expect(props.onOpenModule).toHaveBeenCalledWith("m2");
    fireEvent.keyDown(screen.getByRole("button", { name: "Hutschiene F1 · NAR · 1 Gerät" }), { key: " " });
    expect(props.onOpenRail).toHaveBeenCalledWith("m1", "nar", null);
  });

  it("has no '+' anywhere in the drawing, and every target is a named button", () => {
    const { container } = setup();
    const svg = container.querySelector("svg")!;
    expect(svg.textContent).not.toContain("+");
    const targets = screen.getAllByRole("button");
    expect(targets.length).toBeGreaterThan(10);
    for (const target of targets) {
      const name = target.getAttribute("aria-label") ?? "";
      expect(name.trim()).not.toBe("");
      expect(name).not.toContain("+");
    }
  });

  it("the closed view routes taps the same way", () => {
    const { props } = setup({ scene: renderScene("closed") });
    fireEvent.click(screen.getByRole("button", { name: "Gerät F1.1 auf F2 · Verteiler 1" }));
    expect(props.onOpenRail).toHaveBeenCalledWith("m2", "r1", "ls1");
    fireEvent.click(screen.getByRole("button", { name: "Modul ZH3EL22 in Feld 3" }));
    expect(props.onOpenModule).toHaveBeenCalledWith("m3");
  });
});

describe("hit layer order (what a real tap lands on)", () => {
  // jsdom's click goes straight to the element; a browser hit-tests, and in an
  // SVG the target painted last wins. These keep the layer order the one tap
  // rule depends on.
  const targets = (container: HTMLElement, kind: string) =>
    Array.from(container.querySelectorAll(`.sp-encl-hits [data-target="${kind}"]`));
  const allAfter = (later: Element[], earlier: Element[]) =>
    later.every((element) => earlier.every((before) => (before.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0));

  it("paints devices over rail bands, and rail bands over free units and module backgrounds", () => {
    const { container } = setup();
    const [modules, slots, rails, devices] = ["module", "slot", "rail", "device"].map((kind) => targets(container, kind));
    for (const list of [modules, slots, rails, devices]) expect(list.length).toBeGreaterThan(0);
    expect(allAfter(devices, [...rails, ...slots, ...modules])).toBe(true);
    expect(allAfter(rails, [...slots, ...modules])).toBe(true);
    // Nothing transparent lies over the devices.
    expect(container.querySelector(".sp-encl-hits")!.lastElementChild).toHaveAttribute("data-target", "device");
  });

  it("puts every device target inside the band of its own rail", () => {
    for (const view of ["open", "closed"] as const) {
      const scene = renderScene(view);
      const { container, unmount } = setup({}, scene);
      const bands = railBands(scene);
      const deviceTargets = targets(container, "device");
      expect(deviceTargets.length).toBeGreaterThan(0);
      for (const target of deviceTargets) {
        const id = target.getAttribute("data-device-id");
        const box = scene.boxes.find((candidate) => candidate.deviceId === id && (candidate.kind === "device" || candidate.kind === "device_front"))!;
        const band = bands.find((candidate) => candidate.moduleId === box.moduleId && candidate.railKey === box.railKey)!;
        const [x, y, w, h] = ["x", "y", "width", "height"].map((name) => Number(target.getAttribute(name)));
        expect(x).toBeGreaterThanOrEqual(band.x - 1e-6);
        expect(x + w).toBeLessThanOrEqual(band.x + band.w + 1e-6);
        expect(y).toBeGreaterThanOrEqual(band.y - 1e-6);
        expect(y + h).toBeLessThanOrEqual(band.y + band.h + 1e-6);
      }
      unmount();
    }
  });
});

describe("drawing", () => {
  it("is drawn to scale: cabinet mm × zoom", () => {
    const { container } = setup({ zoom: 0.45 });
    const svg = container.querySelector("svg")!;
    expect(Number(svg.getAttribute("width"))).toBeCloseTo(1300 * 0.45 + 8, 5);
  });

  it("the open view shows meters with their numbers, free places as 'frei', no doors", () => {
    const { container } = setup({ zoom: 1.3 });
    expect(screen.getByText(METER_A)).toBeInTheDocument();
    expect(screen.getByText(METER_B)).toBeInTheDocument();
    expect(screen.getAllByText("frei").length).toBeGreaterThan(0);
    expect(container.querySelectorAll('[data-kind="door"]')).toHaveLength(0);
  });

  it("the closed view shows meter numbers, the blind plate, door leaves and handles", () => {
    const { container } = setup({ scene: renderScene("closed"), zoom: 1.3 });
    expect(screen.getByText(METER_A)).toBeInTheDocument();
    expect(screen.getByText("Blindabdeckung")).toBeInTheDocument();
    expect(container.querySelectorAll('[data-kind="door"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-kind="handle"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-kind="cover"]').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('[data-kind="rail"]')).toHaveLength(0);
  });

  it("marks sealable covers", () => {
    const { container } = setup({ scene: renderScene("closed") });
    expect(container.querySelectorAll(".sp-encl-seal").length).toBeGreaterThan(0);
  });

  it("hides a 1-TE label at the smallest zoom and rotates it at the largest", () => {
    const small = setup({ zoom: ENCLOSURE_ZOOM_STEPS[0] });
    expect(small.container.querySelector('[data-label-for="device:ls1"]')).toBeNull();
    small.unmount();
    const large = setup({ zoom: ENCLOSURE_ZOOM_STEPS[ENCLOSURE_ZOOM_STEPS.length - 1] });
    const label = large.container.querySelector('[data-label-for="device:ls1"]')!;
    expect(label.textContent).toBe("F1.1");
    expect(label.getAttribute("transform")).toMatch(/^rotate\(-90/);
  });

  it("highlights the device, the open rail and the selected module", () => {
    const { container } = setup({ highlightDeviceId: "ls1", selectedModuleId: "m2", activeRail: { moduleId: "m2", railKey: "r1" } });
    expect(container.querySelector('[data-box-id="device:ls1"]')).toHaveClass("is-highlight");
    expect(container.querySelector('[data-box-id="device:fi1"]')).not.toHaveClass("is-highlight");
    expect(container.querySelector('[data-box-id="module:m2"]')).toHaveClass("is-selected");
    expect(container.querySelector('[data-box-id="rail:m2:r1"]')).toHaveClass("is-active");
  });

  it("scrolls the highlighted device into view", () => {
    const { rerender, props } = setup();
    expect(scrollIntoView).not.toHaveBeenCalled();
    rerender(<EnclosureFrontSvg {...props} highlightDeviceId="ls1" />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("flags pre-fitted devices and devices past the rail end", () => {
    const { container } = setup();
    expect(container.querySelector('[data-box-id="device:hs1"]')).toHaveClass("sp-encl-device--supplied");
    expect(container.querySelector('[data-box-id="device:ls1"]')).not.toHaveClass("sp-encl-device--overflow");
  });

  it("draws a module's article number after its zones, which would hide it", () => {
    const { container } = setup();
    const zone = container.querySelector('[data-box-id="zone:m1:aar"]')!;
    const label = container.querySelector('[data-label-for="module:m1"]')!;
    expect(label.textContent).toMatch(/^ZH3EH16/);
    expect(zone.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("writes a meter number smaller rather than cut it", () => {
    const { container } = setup({ zoom: 0.65 });
    const label = container.querySelector('[data-label-for="meter:m1:0"]')!;
    expect(label.textContent).toBe(METER_A);
    expect(Number(label.getAttribute("font-size"))).toBeCloseTo(8 / 0.65, 5);
  });

  it("keeps the top-left corner on a zoom step while nothing was scrolled (the initial fit)", () => {
    const { container, rerender, props } = setup({ zoom: 0.2 });
    rerender(<EnclosureFrontSvg {...props} zoom={0.9} />);
    const scroller = container.querySelector(".sp-encl-scroll")!;
    expect(scroller.scrollLeft).toBe(0);
    expect(scroller.scrollTop).toBe(0);
  });

  it("keeps the visible centre on a zoom step once the drawing was scrolled", () => {
    const { container, rerender, props } = setup({ zoom: 0.45 });
    const scroller = container.querySelector(".sp-encl-scroll")!;
    scroller.scrollLeft = 120;
    fireEvent.scroll(scroller);
    rerender(<EnclosureFrontSvg {...props} zoom={0.65} />);
    // jsdom has no layout: the remembered centre is the middle, and the viewport 0 px wide.
    expect(scroller.scrollLeft).toBeCloseTo((1300 * 0.65 + 8) / 2, 5);
  });

  it("reports the width it has to fit into, once", () => {
    const onFitWidth = vi.fn();
    const { rerender, props } = setup({ onFitWidth });
    expect(onFitWidth).toHaveBeenCalledTimes(1);
    expect(typeof onFitWidth.mock.calls[0][0]).toBe("number");
    rerender(<EnclosureFrontSvg {...props} zoom={0.9} />);
    expect(onFitWidth).toHaveBeenCalledTimes(1);
  });
});

describe("without a slot handler (a read-only board)", () => {
  it("offers no free unit as a button, but still opens rails and modules", () => {
    const { container, props } = setup({ onPickSlot: undefined });
    expect(screen.queryAllByRole("button", { name: /Modul wählen$/ })).toHaveLength(0);
    expect(container.querySelectorAll('[data-target="slot"]')).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Hutschiene F2 · Verteiler 1 · 2 Geräte" }));
    expect(props.onOpenRail).toHaveBeenCalledWith("m2", "r1", null);
    fireEvent.click(screen.getByRole("button", { name: "Modul ZH3EH16 in Feld 1" }));
    expect(props.onOpenModule).toHaveBeenCalledWith("m1");
  });
});

describe("readOnly", () => {
  it("draws the same picture without a single target (the admin preview)", () => {
    const { container } = render(<EnclosureFrontSvg scene={renderScene()} zoom={0.45} highlightDeviceId={null} selectedModuleId={null} readOnly />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByRole("img", { name: /Schrank 1300 × 1100 mm/ })).toBeInTheDocument();
    expect(container.querySelector('[data-box-id="device:ls1"]')).not.toBeNull();
  });
});
