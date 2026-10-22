/**
 * The 3D view's renderer lifecycle (docs/PANEL_ENCLOSURE.md §11 "3D", §12).
 *
 * jsdom has no WebGL, so the renderer and the orbit controls are fakes that
 * record what the view asks of them; the scene graph itself is the real
 * three.js one from `enclosureThreeScene`. What matters on a tablet in the
 * workshop: it renders on demand (no animation loop eating the battery), it
 * gives the GPU context back on every unmount — StrictMode's double mount
 * included — and a device without WebGL2 gets a sentence, not a crash.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { BufferGeometry, Mesh, type Object3D, type PerspectiveCamera, type Scene } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Enclosure3DView from "../components/schaltplan/enclosure/Enclosure3DView";
import type { EnclosureScene } from "../types/panelEnclosure";
import { FIXTURE_BOARDS } from "./enclosureFixtureBoards";

const fakes = vi.hoisted(() => ({
  renderers: [] as Array<Record<string, ReturnType<typeof vi.fn>> & { params: Record<string, unknown> }>,
  controls: [] as Array<{
    dispose: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    domElement: HTMLElement;
    dispatchEvent(event: { type: string }): void;
  }>,
  throwOnCreate: false,
}));

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  class FakeRenderer {
    params: Record<string, unknown>;
    setPixelRatio = vi.fn();
    setSize = vi.fn();
    setClearColor = vi.fn();
    render = vi.fn();
    dispose = vi.fn();
    forceContextLoss = vi.fn();
    constructor(params: Record<string, unknown>) {
      if (fakes.throwOnCreate) throw new Error("Error creating WebGL context.");
      this.params = params;
      fakes.renderers.push(this as never);
    }
  }
  return { ...actual, WebGLRenderer: FakeRenderer };
});

vi.mock("three/addons/controls/OrbitControls.js", async () => {
  const { EventDispatcher, Vector3 } = await vi.importActual<typeof import("three")>("three");
  class FakeControls extends EventDispatcher<{ change: object }> {
    target = new Vector3();
    enableDamping = true;
    minDistance = 0;
    maxDistance = Infinity;
    dispose = vi.fn();
    update = vi.fn(() => false);
    constructor(
      public object: unknown,
      public domElement: HTMLElement,
    ) {
      super();
      fakes.controls.push(this as never);
    }
  }
  return { OrbitControls: FakeControls };
});

const SCENE: EnclosureScene = FIXTURE_BOARDS.meter_dist_zb33s.scene_open!;
const OTHER: EnclosureScene = FIXTURE_BOARDS.tall_zb54s.scene_open!;

class FakeWebGL2 {}

let resizeCallbacks: Array<() => void> = [];

function lastRender(): { scene: Scene; camera: PerspectiveCamera } {
  const renderer = fakes.renderers[fakes.renderers.length - 1];
  const calls = renderer.render.mock.calls;
  const call = calls[calls.length - 1];
  return { scene: call[0] as Scene, camera: call[1] as PerspectiveCamera };
}

function objectNamed(root: Object3D, name: string): Object3D {
  const found = root.getObjectByName(name);
  if (!found) throw new Error(`no object ${name}`);
  return found;
}

beforeEach(() => {
  fakes.renderers.length = 0;
  fakes.controls.length = 0;
  fakes.throwOnCreate = false;
  resizeCallbacks = [];
  vi.stubGlobal("WebGL2RenderingContext", FakeWebGL2);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function getContext(this: HTMLCanvasElement, type: string) {
    return type === "webgl2" ? (new FakeWebGL2() as never) : null;
  } as never);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resizeCallbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Enclosure3DView", () => {
  it("creates one low-power, antialiased WebGL2 renderer on a canvas of its own and draws once", () => {
    render(<Enclosure3DView scene={SCENE} onExit={() => undefined} />);
    expect(fakes.renderers).toHaveLength(1);
    const renderer = fakes.renderers[0];
    const canvas = renderer.params.canvas as HTMLCanvasElement;
    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
    expect(canvas.isConnected).toBe(true);
    expect(renderer.params.context).toBeInstanceOf(FakeWebGL2);
    expect(HTMLCanvasElement.prototype.getContext).toHaveBeenCalledWith(
      "webgl2",
      expect.objectContaining({ antialias: true, powerPreference: "low-power" }),
    );
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(canvas.style.touchAction).toBe("none");
    expect(fakes.controls[0].domElement).toBe(canvas);
  });

  it("caps the pixel ratio at 2", () => {
    vi.stubGlobal("devicePixelRatio", 3);
    render(<Enclosure3DView scene={SCENE} onExit={() => undefined} />);
    expect(fakes.renderers[0].setPixelRatio).toHaveBeenCalledWith(2);
  });

  it("draws the cabinet's boxes without the cover layer", () => {
    const closed = FIXTURE_BOARDS.meter_dist_zb33s.scene_closed!;
    render(<Enclosure3DView scene={closed} onExit={() => undefined} />);
    const { scene } = lastRender();
    expect(scene.getObjectByName("shell")).toBeInstanceOf(Mesh);
    expect(scene.getObjectByName(closed.boxes.find((box) => box.kind === "rail")!.id)).toBeInstanceOf(Mesh);
    expect(scene.getObjectByName(closed.boxes.find((box) => box.kind === "cover")!.id)).toBeUndefined();
    expect(scene.getObjectByName(closed.boxes.find((box) => box.kind === "device_front")!.id)).toBeUndefined();
  });

  it("renders on demand only: no animation loop", () => {
    const raf = vi.spyOn(window, "requestAnimationFrame");
    render(<Enclosure3DView scene={SCENE} onExit={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Schräg" }));
    expect(raf).not.toHaveBeenCalled();
  });

  it("re-renders on a controls change and on a resize", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    render(<Enclosure3DView scene={SCENE} onExit={() => undefined} />);
    const renderer = fakes.renderers[0];
    const before = renderer.render.mock.calls.length;
    act(() => fakes.controls[0].dispatchEvent({ type: "change" }));
    expect(renderer.render.mock.calls.length).toBe(before + 1);
    act(() => resizeCallbacks.forEach((callback) => callback()));
    expect(renderer.setSize).toHaveBeenLastCalledWith(900, 600, false);
    expect(lastRender().camera.aspect).toBeCloseTo(1.5, 6);
    expect(renderer.render.mock.calls.length).toBe(before + 2);
  });

  it("moves the camera for Front, Schräg and Seite", () => {
    render(<Enclosure3DView scene={SCENE} onExit={() => undefined} />);
    const front = lastRender().camera.position.clone();
    expect(front.x).toBeCloseTo(0, 6);
    fireEvent.click(screen.getByRole("button", { name: "Schräg" }));
    const oblique = lastRender().camera.position.clone();
    expect(oblique.x).toBeGreaterThan(0);
    expect(oblique.y).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Seite" }));
    const side = lastRender().camera.position.clone();
    expect(side.x).toBeGreaterThan(oblique.x);
    fireEvent.click(screen.getByRole("button", { name: "Front" }));
    expect(lastRender().camera.position.distanceTo(front)).toBeCloseTo(0, 6);
  });

  it("zooms with + and − (buttons, no pinch needed)", () => {
    render(<Enclosure3DView scene={SCENE} onExit={() => undefined} />);
    const start = lastRender().camera.position.length();
    fireEvent.click(screen.getByRole("button", { name: "Vergrößern" }));
    const closer = lastRender().camera.position.length();
    expect(closer).toBeLessThan(start);
    fireEvent.click(screen.getByRole("button", { name: "Verkleinern" }));
    fireEvent.click(screen.getByRole("button", { name: "Verkleinern" }));
    expect(lastRender().camera.position.length()).toBeGreaterThan(start);
    expect(screen.getByRole("button", { name: "Vergrößern" })).toHaveTextContent("+");
    expect(screen.getByRole("button", { name: "Verkleinern" })).toHaveTextContent("−");
  });

  it("opens with the doors open and toggles them with Tür zu / Tür auf", () => {
    render(<Enclosure3DView scene={SCENE} onExit={() => undefined} />);
    expect(Math.abs(objectNamed(lastRender().scene, "door:0").parent!.rotation.y)).toBeGreaterThan(1);
    fireEvent.click(screen.getByRole("button", { name: "Tür zu" }));
    expect(objectNamed(lastRender().scene, "door:0").parent!.rotation.y).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Tür auf" }));
    expect(Math.abs(objectNamed(lastRender().scene, "door:0").parent!.rotation.y)).toBeGreaterThan(1);
  });

  it("leaves through 2D", () => {
    const onExit = vi.fn();
    render(<Enclosure3DView scene={SCENE} onExit={onExit} />);
    fireEvent.click(screen.getByRole("button", { name: "2D" }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("swaps the scene without a new renderer and disposes the old one's geometry", () => {
    const dispose = vi.spyOn(BufferGeometry.prototype, "dispose");
    const { rerender } = render(<Enclosure3DView scene={SCENE} onExit={() => undefined} />);
    // Building the shell merges five wall panels and drops the parts: that is construction, not teardown.
    const afterBuild = dispose.mock.calls.length;
    rerender(<Enclosure3DView scene={SCENE} onExit={() => undefined} />);
    expect(dispose.mock.calls.length).toBe(afterBuild);
    rerender(<Enclosure3DView scene={OTHER} onExit={() => undefined} />);
    expect(fakes.renderers).toHaveLength(1);
    expect(dispose.mock.calls.length).toBeGreaterThan(afterBuild + 5);
    const zone = OTHER.boxes.find((box) => box.kind === "zone")!;
    expect(lastRender().scene.getObjectByName(zone.id)).toBeInstanceOf(Mesh);
  });

  it("gives everything back on unmount: geometry, controls, renderer, GPU context, canvas", () => {
    const dispose = vi.spyOn(BufferGeometry.prototype, "dispose");
    const { unmount } = render(<Enclosure3DView scene={SCENE} onExit={() => undefined} />);
    const renderer = fakes.renderers[0];
    const canvas = renderer.params.canvas as HTMLCanvasElement;
    const afterBuild = dispose.mock.calls.length;
    unmount();
    expect(fakes.controls[0].dispose).toHaveBeenCalledTimes(1);
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
    expect(renderer.forceContextLoss).toHaveBeenCalledTimes(1);
    expect(dispose.mock.calls.length).toBeGreaterThan(afterBuild + 5);
    expect(canvas.isConnected).toBe(false);
  });

  it("survives StrictMode's double mount: the first renderer is released, one canvas remains", () => {
    const { container } = render(
      <StrictMode>
        <Enclosure3DView scene={SCENE} onExit={() => undefined} />
      </StrictMode>,
    );
    expect(fakes.renderers).toHaveLength(2);
    const [first, second] = fakes.renderers;
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(first.forceContextLoss).toHaveBeenCalledTimes(1);
    expect(second.dispose).not.toHaveBeenCalled();
    // A fresh canvas per mount: a canvas whose context was force-lost cannot host a new renderer.
    expect(first.params.canvas).not.toBe(second.params.canvas);
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
    // forceContextLoss fires webglcontextlost on the released canvas a moment later;
    // it must not put the live view into the error state.
    act(() => {
      (first.params.canvas as HTMLCanvasElement).dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    });
    expect(screen.queryByText("3D konnte nicht geladen werden.")).not.toBeInTheDocument();
  });

  it("offers 3D neu laden when the GPU drops the context, and starts over on a fresh canvas", () => {
    render(<Enclosure3DView scene={SCENE} onExit={() => undefined} />);
    const first = fakes.renderers[0];
    const lost = new Event("webglcontextlost", { cancelable: true });
    act(() => {
      (first.params.canvas as HTMLCanvasElement).dispatchEvent(lost);
    });
    expect(lost.defaultPrevented).toBe(true);
    expect(screen.getByText("3D konnte nicht geladen werden.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "3D neu laden" }));
    expect(fakes.renderers).toHaveLength(2);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("3D konnte nicht geladen werden.")).not.toBeInTheDocument();
  });

  it("says so without WebGL2, and 2D still leads back", () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("WebGL2RenderingContext", undefined);
    const onExit = vi.fn();
    render(<Enclosure3DView scene={SCENE} onExit={onExit} />);
    expect(screen.getByText("3D ist auf diesem Gerät nicht verfügbar — die 2D-Ansicht zeigt dasselbe.")).toBeInTheDocument();
    expect(fakes.renderers).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Front" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "2D" }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("says so when the browser has WebGL2 but refuses a context", () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    render(<Enclosure3DView scene={SCENE} onExit={() => undefined} />);
    expect(screen.getByText("3D ist auf diesem Gerät nicht verfügbar — die 2D-Ansicht zeigt dasselbe.")).toBeInTheDocument();
    expect(document.querySelectorAll("canvas")).toHaveLength(0);
  });

  it("says so when the renderer cannot start, instead of crashing the page", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fakes.throwOnCreate = true;
    render(<Enclosure3DView scene={SCENE} onExit={() => undefined} />);
    expect(screen.getByText("3D ist auf diesem Gerät nicht verfügbar — die 2D-Ansicht zeigt dasselbe.")).toBeInTheDocument();
    expect(document.querySelectorAll("canvas")).toHaveLength(0);
  });

  it("says so when asking for a context throws", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(() => {
      throw new Error("blocked by policy");
    });
    render(<Enclosure3DView scene={SCENE} onExit={() => undefined} />);
    expect(screen.getByText("3D ist auf diesem Gerät nicht verfügbar — die 2D-Ansicht zeigt dasselbe.")).toBeInTheDocument();
    expect(console.warn).toHaveBeenCalled();
  });

  it("still gives the context back and removes the canvas when one teardown step throws", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { unmount } = render(<Enclosure3DView scene={SCENE} onExit={() => undefined} />);
    const renderer = fakes.renderers[0];
    renderer.dispose.mockImplementation(() => {
      throw new Error("driver bug");
    });
    expect(() => unmount()).not.toThrow();
    expect(renderer.forceContextLoss).toHaveBeenCalledTimes(1);
    expect((renderer.params.canvas as HTMLCanvasElement).isConnected).toBe(false);
    expect(console.warn).toHaveBeenCalledWith("3D: Renderer fehlgeschlagen", expect.any(Error));
  });

  it("gives every control a glove-sized button", () => {
    render(<Enclosure3DView scene={SCENE} onExit={() => undefined} />);
    for (const name of ["Front", "Schräg", "Seite", "Tür zu", "Vergrößern", "Verkleinern", "2D"]) {
      expect(screen.getByRole("button", { name })).toHaveClass("sp-encl-3d-btn");
    }
  });
});
