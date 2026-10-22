/**
 * The renderer around the cabinet's scene graph (docs/PANEL_ENCLOSURE.md §12).
 *
 * Imperative on purpose — a WebGL renderer, a camera and orbit controls are
 * mutable objects with a lifetime — and kept out of React so the view stays a
 * thin shell. The rules it keeps:
 *
 * * Render on demand: a controls change, a resize, a door toggle, a preset or
 *   a zoom step draws one frame. No animation loop (battery, workshop tablet),
 *   hence no damping on the controls.
 * * One canvas per stage. `dispose` gives back geometry, materials, controls,
 *   renderer and the GPU context (`forceContextLoss`) and removes the canvas;
 *   a canvas whose context was force-lost cannot host a renderer again, so a
 *   remount (StrictMode, "3D neu laden") always starts on a fresh one.
 * * WebGL2 only (three ≥ r163 dropped WebGL1); no context → the caller shows
 *   the fallback sentence instead.
 */
import { DirectionalLight, type Group, HemisphereLight, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import type { EnclosureScene } from "../../../types/panelEnclosure";
import {
  buildThreeGroup,
  cameraPose,
  type CameraPreset,
  disposeGroup,
  fitDistance,
  setDoorOpen as swingDoors,
  stepDistance,
} from "./enclosureThreeScene";

const FOV_DEG = 35;
const NEAR_MM = 10;
const FAR_MM = 100_000;
const MAX_PIXEL_RATIO = 2;
/** Orbit-zoom limits relative to the fitted distance. */
const MIN_DISTANCE_FACTOR = 0.3;
const MAX_DISTANCE_FACTOR = 3;

/** Battery before speed; transparent, so the page's own background shows behind the cabinet. */
export const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  antialias: true,
  depth: true,
  stencil: false,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
  powerPreference: "low-power",
};

export interface Stage {
  setScene(scene: EnclosureScene): void;
  setDoorOpen(open: boolean): void;
  preset(preset: CameraPreset): void;
  zoom(direction: "in" | "out"): void;
  dispose(): void;
}

interface StageOptions {
  host: HTMLElement;
  canvas: HTMLCanvasElement;
  context: WebGL2RenderingContext;
  scene: EnclosureScene;
  doorOpen: boolean;
  onContextLost(): void;
}

/** A WebGL2 context with our attributes, or null where the device has none. */
export function createWebGL2Context(canvas: HTMLCanvasElement): WebGL2RenderingContext | null {
  if (typeof WebGL2RenderingContext === "undefined") return null;
  try {
    return canvas.getContext("webgl2", CONTEXT_ATTRIBUTES) as WebGL2RenderingContext | null;
  } catch (error) {
    console.warn("3D: kein WebGL2-Kontext", error);
    return null;
  }
}

/** Run one teardown step; a failing step must not keep the others from releasing their part. */
function release(step: string, action: () => void): void {
  try {
    action();
  } catch (error) {
    console.warn(`3D: ${step} fehlgeschlagen`, error);
  }
}

class EnclosureStage implements Stage {
  private readonly renderer: WebGLRenderer;
  private readonly world = new Scene();
  private readonly camera = new PerspectiveCamera(FOV_DEG, 1, NEAR_MM, FAR_MM);
  private readonly controls: OrbitControls;
  private readonly resizeObserver: ResizeObserver | null;
  private group: Group;
  private scene: EnclosureScene;
  private doorOpen: boolean;
  private currentPreset: CameraPreset = "front";
  private batching = false;
  private disposed = false;

  constructor(private readonly options: StageOptions) {
    const { canvas, context } = options;
    this.renderer = new WebGLRenderer({ canvas, context, antialias: true, alpha: true, powerPreference: "low-power" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    this.renderer.setClearColor(0x000000, 0);
    canvas.style.touchAction = "none";
    canvas.addEventListener("webglcontextlost", this.handleContextLost);
    this.addLights();
    this.scene = options.scene;
    this.doorOpen = options.doorOpen;
    this.group = buildThreeGroup(this.scene, { doorOpen: this.doorOpen });
    this.world.add(this.group);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = false;
    this.controls.addEventListener("change", this.render);
    this.resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(this.handleResize);
    this.resizeObserver?.observe(options.host);
    this.resize();
    this.batch(() => this.applyPreset("front"));
  }

  /** Light that follows the camera, so whatever side is shown is lit. */
  private addLights(): void {
    this.world.add(new HemisphereLight(0xffffff, 0x9aa6b4, 1.6));
    const key = new DirectionalLight(0xffffff, 1.8);
    key.position.set(0.5, 0.9, 1);
    this.camera.add(key);
    this.world.add(this.camera);
  }

  private readonly render = (): void => {
    if (this.disposed || this.batching) return;
    this.renderer.render(this.world, this.camera);
  };

  /** Run several camera moves and draw once at the end. */
  private batch(action: () => void): void {
    this.batching = true;
    try {
      action();
    } finally {
      this.batching = false;
    }
    this.render();
  }

  private readonly handleContextLost = (event: Event): void => {
    // Without preventDefault the browser would never hand the context back.
    event.preventDefault();
    this.options.onContextLost();
  };

  private readonly handleResize = (): void => {
    if (this.disposed) return;
    this.resize();
    this.render();
  };

  private resize(): void {
    const width = Math.max(1, this.options.host.clientWidth);
    const height = Math.max(1, this.options.host.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private applyPreset(preset: CameraPreset): void {
    const pose = cameraPose(this.scene, preset, this.camera.aspect, FOV_DEG);
    const fitted = fitDistance(this.scene, this.camera.aspect, FOV_DEG);
    this.currentPreset = preset;
    this.controls.minDistance = fitted * MIN_DISTANCE_FACTOR;
    this.controls.maxDistance = fitted * MAX_DISTANCE_FACTOR;
    this.controls.target.set(...pose.target);
    this.camera.position.set(...pose.position);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
  }

  setScene(scene: EnclosureScene): void {
    if (this.disposed || scene === this.scene) return;
    const resized = scene.width !== this.scene.width || scene.height !== this.scene.height || scene.depth !== this.scene.depth;
    this.world.remove(this.group);
    disposeGroup(this.group);
    this.scene = scene;
    this.group = buildThreeGroup(scene, { doorOpen: this.doorOpen });
    this.world.add(this.group);
    if (resized) this.batch(() => this.applyPreset(this.currentPreset));
    else this.render();
  }

  setDoorOpen(open: boolean): void {
    if (this.disposed || open === this.doorOpen) return;
    this.doorOpen = open;
    swingDoors(this.group, open);
    this.render();
  }

  preset(preset: CameraPreset): void {
    if (this.disposed) return;
    this.batch(() => this.applyPreset(preset));
  }

  zoom(direction: "in" | "out"): void {
    if (this.disposed) return;
    const offset = new Vector3().subVectors(this.camera.position, this.controls.target);
    const next = stepDistance(offset.length(), direction, this.controls.minDistance, this.controls.maxDistance);
    this.camera.position.copy(this.controls.target).addScaledVector(offset.normalize(), next);
    this.batch(() => this.controls.update());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const { canvas } = this.options;
    release("Steuerung", () => {
      this.controls.removeEventListener("change", this.render);
      this.controls.dispose();
    });
    release("Größenbeobachtung", () => this.resizeObserver?.disconnect());
    canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    release("Szene", () => {
      disposeGroup(this.group);
      this.world.clear();
    });
    release("Renderer", () => this.renderer.dispose());
    release("Kontext", () => this.renderer.forceContextLoss());
    canvas.remove();
  }
}

/**
 * Put a fresh canvas into `host` and start rendering `scene` on it. Null when
 * the device has no WebGL2 or the renderer cannot start; nothing is left in
 * the DOM then.
 */
export function mountStage(
  host: HTMLElement,
  scene: EnclosureScene,
  doorOpen: boolean,
  onContextLost: () => void,
): Stage | null {
  const canvas = host.ownerDocument.createElement("canvas");
  canvas.className = "sp-encl-3d-canvas";
  const context = createWebGL2Context(canvas);
  if (!context) return null;
  try {
    const stage = new EnclosureStage({ host, canvas, context, scene, doorOpen, onContextLost });
    host.appendChild(canvas);
    return stage;
  } catch (error) {
    console.warn("3D: Renderer konnte nicht starten", error);
    // Hand the context back at once rather than whenever the canvas is collected.
    release("Kontext", () => context.getExtension?.("WEBGL_lose_context")?.loseContext());
    return null;
  }
}
