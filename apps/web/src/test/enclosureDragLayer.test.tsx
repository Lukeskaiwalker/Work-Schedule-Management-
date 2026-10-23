/**
 * What a device drag shows (docs/PANEL_ENCLOSURE_R2.md §6.6): from the
 * moment it arms, a ghost of at least 44 × 44 px with the BMK, 56 px above
 * the finger; the floating label `{bmk} {short} → {title} · nach {bmk}` in
 * a fixed-position portal; the source dimmed; the target band marked; a
 * constant-px insertion bar; and an aria-live echo that changes only when
 * (rail, place, refusal) does.
 *
 * Invented boards only — the repo is public.
 */
import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";

import { createDragStore, EnclosureDragLayer, GHOST_MIN_PX, GHOST_OFFSET_PX, type DragView } from "../components/schaltplan/enclosure/EnclosureDragLayer";
import type { DeviceDrop } from "../components/schaltplan/enclosure/enclosureDropTargets";
import { railBands } from "../components/schaltplan/enclosure/enclosureFrontLayout";
import { renderScene } from "./enclosureRenderBoard";

const drop = (patch: Partial<DeviceDrop> = {}): DeviceDrop => ({
  moduleId: "m2", railKey: "r3", rowId: null, at: 3, indicatorX: 360, bandBoxId: "rail:m2:r3", title: "F2 · Verteiler 3",
  afterLabel: "F1.3", overMm: 0, refused: null, ...patch,
});

const view = (patch: Partial<DragView> = {}): DragView => ({
  deviceIds: ["ls1"], name: "F1.4 LS B16", ghost: "F1.4", client: { x: 200, y: 300 }, drop: drop(), ...patch,
});

function setup(zoom = 0.65) {
  const scene = renderScene();
  const store = createDragStore();
  const utils = render(
    <svg>
      <EnclosureDragLayer store={store} scene={scene} bands={railBands(scene)} zoom={zoom} />
    </svg>,
  );
  return { ...utils, store, set: (next: DragView | null) => act(() => store.set(next)) };
}

describe("EnclosureDragLayer", () => {
  it("shows nothing until a drag arms", () => {
    const { container } = setup();
    expect(container.querySelector(".sp-encl-drag-source")).toBeNull();
    expect(document.querySelector(".sp-encl-drag-ghost")).toBeNull();
    expect(document.querySelector(".sp-encl-drag-label")).toBeNull();
  });

  it("shows the label, the ghost above the finger and the dimmed source at once", () => {
    const { set, container } = setup();
    set(view());
    expect(screen.getByText("F1.4 LS B16 → F2 · Verteiler 3 · nach F1.3", { selector: ".sp-encl-drag-label" })).toBeInTheDocument();
    const ghost = document.querySelector<HTMLElement>(".sp-encl-drag-ghost")!;
    expect(ghost).toHaveTextContent("F1.4");
    expect(parseFloat(ghost.style.minWidth)).toBeGreaterThanOrEqual(44);
    expect(parseFloat(ghost.style.minHeight)).toBeGreaterThanOrEqual(44);
    expect(GHOST_MIN_PX).toBeGreaterThanOrEqual(44);
    // Centred 56 px above the finger, out from under a gloved fingertip.
    expect(parseFloat(ghost.style.top)).toBe(300 - GHOST_OFFSET_PX - GHOST_MIN_PX / 2);
    expect(GHOST_OFFSET_PX).toBe(56);
    expect(container.querySelector('.sp-encl-drag-source[data-device-id="ls1"]')).not.toBeNull();
  });

  it("marks the target band and draws a constant-px insertion bar", () => {
    const { set, container } = setup(0.45);
    set(view({ drop: drop({ moduleId: "m2", railKey: "r1", bandBoxId: "rail:m2:r1", indicatorX: 382.5 }) }));
    const band = container.querySelector(".sp-encl-drop-band")!;
    expect(band).toHaveClass("is-drop-target");
    expect(band.getAttribute("data-band")).toBe("rail:m2:r1");
    const bar = container.querySelector(".sp-encl-drop-bar")!;
    expect(Number(bar.getAttribute("width")) * 0.45).toBeCloseTo(3, 5);
    expect(Number(bar.getAttribute("x")) + Number(bar.getAttribute("width")) / 2).toBeCloseTo(382.5, 5);
  });

  it("marks a refused band as refused, and says why", () => {
    const { set, container } = setup();
    set(view({ drop: drop({ moduleId: "m2", railKey: "r1", bandBoxId: "rail:m2:r1", refused: "terminal_rail" }) }));
    expect(container.querySelector(".sp-encl-drop-band")).toHaveClass("is-refused");
    expect(container.querySelector(".sp-encl-drop-bar")).toBeNull();
    expect(document.querySelector(".sp-encl-drag-label")).toHaveTextContent("Reihenklemmen-Schiene — hier keine Geräte");
  });

  it("echoes for screen readers only when rail, place or refusal change", () => {
    const { set } = setup();
    set(view());
    const live = document.querySelector(".sp-encl-drag-live")!;
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent("F1.4 LS B16 → F2 · Verteiler 3 · nach F1.3");
    const node = live.firstChild;
    set(view({ client: { x: 220, y: 310 } }));
    expect(live.firstChild).toBe(node);
    set(view({ drop: drop({ at: 4, afterLabel: "F1.4" }) }));
    expect(live).toHaveTextContent("F1.4 LS B16 → F2 · Verteiler 3 · nach F1.4");
  });

  it("names the source alone over no rail, and clears everything when the drag ends", () => {
    const { set, container } = setup();
    set(view({ drop: null }));
    expect(document.querySelector(".sp-encl-drag-label")).toHaveTextContent(/^F1\.4 LS B16$/);
    expect(container.querySelector(".sp-encl-drop-band")).toBeNull();
    set(null);
    expect(document.querySelector(".sp-encl-drag-ghost")).toBeNull();
    expect(container.querySelector(".sp-encl-drag-source")).toBeNull();
  });
});
