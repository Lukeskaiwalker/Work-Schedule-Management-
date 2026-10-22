/**
 * The cabinet as a three.js scene graph (docs/PANEL_ENCLOSURE.md §12).
 *
 * Pure construction: boxes in, objects out, no renderer and no WebGL, so it
 * runs (and is tested) in jsdom. Every position comes from
 * `buildEnclosureScene` (§4); this module only maps the scene's frame —
 * origin top-left of the back face, y down — into three's y-up frame with the
 * cabinet centred on the origin, and hangs each door leaf on a pivot at its
 * outer edge. Procedural boxes only: no loaders, no textures, no workers,
 * nothing fetched (CSP `script-src 'self'`, `worker-src 'self'`).
 *
 * The 3D view shows the open interior, so the cover layer of a closed scene
 * (covers, slots, fronts, windows, blind plates) is skipped. Labels stay in
 * the 2D view, where devices are tapped and named.
 */
import {
  BoxGeometry,
  BufferGeometry,
  EdgesGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  type Material,
  Mesh,
  MeshLambertMaterial,
  type Object3D,
} from "three";

import type { EnclosureScene, SceneBox, SceneBoxKind } from "../../../types/panelEnclosure";

/** What a closed scene adds in front of the interior; the 3D view never draws it. */
export const COVER_LAYER_KINDS: ReadonlySet<SceneBoxKind> = new Set<SceneBoxKind>([
  "cover",
  "cover_slot",
  "device_front",
  "window",
  "meter_front",
  "blind_plate",
]);

/** How far a door leaf swings open about its outer edge. */
export const DOOR_OPEN_DEG = 100;
const DOOR_OPEN_RAD = (DOOR_OPEN_DEG * Math.PI) / 180;

/** Drawn wall thickness of the shell — a drawing approximation; it stays behind the field plates (z ≥ 10). */
const SHELL_WALL_MM = 6;

const OUTLINED: ReadonlySet<SceneBoxKind> = new Set<SceneBoxKind>(["module", "zone", "device"]);

/** One colour per kind, plus the variants a flag calls for. Hager univers Z is RAL 9010 white. */
const COLOURS: Readonly<Record<string, number>> = {
  shell: 0xf2f2ee,
  field: 0xc9d1db,
  module: 0xe4e9ef,
  "module:unknown": 0xf6d9a8,
  zone: 0xf6f8fa,
  rail: 0xa9b2bc,
  busbar: 0xc27c48,
  device: 0xfbfbf8,
  "device:supplied": 0xd7e5f6,
  "device:overflow": 0xf3b9b2,
  meter: 0x3b4652,
  meter_place: 0xe6ebf1,
  door: 0xf7f7f4,
  handle: 0x56606b,
};
const FALLBACK_COLOUR = 0xdddddd;
const EDGE_COLOUR = 0x6b7a8c;

/** A free meter place lies exactly on its zone (same z and depth); pull it forward in depth, not in space. */
const POLYGON_OFFSET: ReadonlySet<string> = new Set(["meter_place"]);

export interface ThreeSceneOptions {
  doorOpen: boolean;
}

type Hinge = "left" | "right";

interface BuildContext {
  scene: EnclosureScene;
  geometries: Map<string, BufferGeometry>;
  edges: Map<string, EdgesGeometry>;
  materials: Map<string, Material>;
  /** Created on the first outline, so a scene without one leaves nothing undisposed behind. */
  edgeMaterial: LineBasicMaterial | null;
}

// ── Frame ────────────────────────────────────────────────────────────────────

/** Centre of a scene box in three's frame: cabinet centred on the origin, y up. */
function centreOf(box: SceneBox, scene: EnclosureScene): [number, number, number] {
  return [
    box.x + box.w / 2 - scene.width / 2,
    scene.height / 2 - (box.y + box.h / 2),
    box.z + box.d / 2 - scene.depth / 2,
  ];
}

function drawable(box: SceneBox): boolean {
  const numbers = [box.x, box.y, box.z, box.w, box.h, box.d];
  return numbers.every(Number.isFinite) && box.w > 0 && box.h > 0 && box.d > 0 && !COVER_LAYER_KINDS.has(box.kind);
}

// ── Geometry ─────────────────────────────────────────────────────────────────

/** Five panels, no front: the interior shows from every side, the walls stay solid from outside. */
function openBoxGeometry(w: number, h: number, d: number): BufferGeometry {
  const t = Math.min(SHELL_WALL_MM, w / 2, h / 2, d);
  const panels: Array<[number, number, number, number, number, number]> = [
    [w, h, t, 0, 0, -d / 2 + t / 2],
    [t, h, d, -w / 2 + t / 2, 0, 0],
    [t, h, d, w / 2 - t / 2, 0, 0],
    [w, t, d, 0, h / 2 - t / 2, 0],
    [w, t, d, 0, -h / 2 + t / 2, 0],
  ];
  return mergeIndexed(panels.map(([pw, ph, pd, x, y, z]) => new BoxGeometry(pw, ph, pd).translate(x, y, z)));
}

/** Concatenate indexed geometries with the same attributes (BufferGeometryUtils is an addon we do not ship). */
function mergeIndexed(parts: BufferGeometry[]): BufferGeometry {
  const names = ["position", "normal", "uv"] as const;
  const data: Record<(typeof names)[number], number[]> = { position: [], normal: [], uv: [] };
  const indices: number[] = [];
  let offset = 0;
  for (const part of parts) {
    for (const name of names) data[name].push(...Array.from(part.getAttribute(name).array as ArrayLike<number>));
    const index = part.getIndex();
    if (index) for (let i = 0; i < index.count; i += 1) indices.push(index.getX(i) + offset);
    offset += part.getAttribute("position").count;
    part.dispose();
  }
  const merged = new BufferGeometry();
  merged.setAttribute("position", new Float32BufferAttribute(data.position, 3));
  merged.setAttribute("normal", new Float32BufferAttribute(data.normal, 3));
  merged.setAttribute("uv", new Float32BufferAttribute(data.uv, 2));
  merged.setIndex(indices);
  return merged;
}

function geometryKey(box: SceneBox): string {
  return `${box.kind}:${box.w}:${box.h}:${box.d}`;
}

function geometryFor(ctx: BuildContext, box: SceneBox): BufferGeometry {
  const key = geometryKey(box);
  const cached = ctx.geometries.get(key);
  if (cached) return cached;
  const geometry = box.kind === "shell" ? openBoxGeometry(box.w, box.h, box.d) : new BoxGeometry(box.w, box.h, box.d);
  ctx.geometries.set(key, geometry);
  return geometry;
}

function edgesFor(ctx: BuildContext, box: SceneBox, geometry: BufferGeometry): EdgesGeometry {
  const key = geometryKey(box);
  const cached = ctx.edges.get(key);
  if (cached) return cached;
  const edges = new EdgesGeometry(geometry);
  ctx.edges.set(key, edges);
  return edges;
}

// ── Materials ────────────────────────────────────────────────────────────────

function colourKey(box: SceneBox): string {
  if (box.kind === "device" && box.flags.includes("overflow")) return "device:overflow";
  if (box.kind === "device" && box.flags.includes("supplied")) return "device:supplied";
  if (box.kind === "module" && box.flags.includes("unknown_code")) return "module:unknown";
  return box.kind;
}

function materialFor(ctx: BuildContext, box: SceneBox): Material {
  const key = colourKey(box);
  const cached = ctx.materials.get(key);
  if (cached) return cached;
  const offset = POLYGON_OFFSET.has(key);
  const material = new MeshLambertMaterial({
    color: COLOURS[key] ?? FALLBACK_COLOUR,
    polygonOffset: offset,
    polygonOffsetFactor: offset ? -1 : 0,
    polygonOffsetUnits: offset ? -1 : 0,
  });
  ctx.materials.set(key, material);
  return material;
}

// ── Meshes ───────────────────────────────────────────────────────────────────

function meshFor(ctx: BuildContext, box: SceneBox): Mesh {
  const geometry = geometryFor(ctx, box);
  const mesh = new Mesh(geometry, materialFor(ctx, box));
  mesh.name = box.id;
  mesh.position.set(...centreOf(box, ctx.scene));
  mesh.userData = {
    boxId: box.id,
    kind: box.kind,
    moduleId: box.moduleId,
    railKey: box.railKey,
    rowId: box.rowId,
    deviceId: box.deviceId,
    zoneType: box.zoneType,
    flags: [...box.flags],
  };
  if (OUTLINED.has(box.kind)) {
    ctx.edgeMaterial ??= new LineBasicMaterial({ color: EDGE_COLOUR });
    mesh.add(new LineSegments(edgesFor(ctx, box, geometry), ctx.edgeMaterial));
  }
  return mesh;
}

// ── Door leaves ──────────────────────────────────────────────────────────────

/**
 * Hinge side of leaf `i` of `leaves`, opposite its handle (`handleX` in the
 * geometry): one leaf hinges left; with more, a leaf whose centre lies left
 * of the cabinet's centre hinges left, every other one right.
 */
export function doorHinge(i: number, leaves: number): Hinge {
  if (leaves <= 1) return "left";
  return 2 * i + 1 < leaves ? "left" : "right";
}

const LEAF_ID: Readonly<Record<"door" | "handle", RegExp>> = { door: /^door:(\d+)$/, handle: /^handle:(\d+)$/ };

function leafIndex(box: SceneBox, prefix: "door" | "handle"): number | null {
  const match = LEAF_ID[prefix].exec(box.id);
  return match ? Number(match[1]) : null;
}

function leafPivots(ctx: BuildContext, doors: SceneBox[]): Map<number, Group> {
  const leaves = doors.filter((door) => leafIndex(door, "door") !== null);
  const pivots = new Map<number, Group>();
  for (const door of leaves) {
    const index = leafIndex(door, "door")!;
    if (pivots.has(index)) continue;
    const hinge = doorHinge(index, leaves.length);
    const pivot = new Group();
    pivot.name = `leaf:${index}`;
    pivot.position.set((hinge === "left" ? door.x : door.x + door.w) - ctx.scene.width / 2, 0, door.z - ctx.scene.depth / 2);
    pivot.userData = { doorLeaf: index, hingeSign: hinge === "left" ? -1 : 1 };
    pivots.set(index, pivot);
  }
  return pivots;
}

/** Re-express a mesh placed in the group's frame in its pivot's frame (pivots start unrotated). */
function attachToPivot(pivot: Group, mesh: Mesh): void {
  mesh.position.sub(pivot.position);
  pivot.add(mesh);
}

/** Swing every door leaf of a group built by `buildThreeGroup` open or shut. */
export function setDoorOpen(group: Object3D, open: boolean): void {
  group.traverse((object) => {
    if (typeof object.userData.doorLeaf !== "number") return;
    object.rotation.y = open ? Number(object.userData.hingeSign) * DOOR_OPEN_RAD : 0;
  });
}

// ── Build / dispose ──────────────────────────────────────────────────────────

/** The scene graph of a cabinet: one mesh per drawable box, door leaves on pivots. */
export function buildThreeGroup(scene: EnclosureScene, opts: ThreeSceneOptions): Group {
  const ctx: BuildContext = {
    scene,
    geometries: new Map(),
    edges: new Map(),
    materials: new Map(),
    edgeMaterial: null,
  };
  const group = new Group();
  group.name = "enclosure";
  const boxes = scene.boxes.filter(drawable);
  const pivots = leafPivots(ctx, boxes.filter((box) => box.kind === "door"));
  for (const box of boxes) {
    const mesh = meshFor(ctx, box);
    const leaf = box.kind === "door" || box.kind === "handle" ? leafIndex(box, box.kind) : null;
    const pivot = leaf === null ? undefined : pivots.get(leaf);
    if (pivot) attachToPivot(pivot, mesh);
    else group.add(mesh);
  }
  for (const pivot of pivots.values()) group.add(pivot);
  setDoorOpen(group, opts.doorOpen);
  return group;
}

/**
 * Release every geometry and material under `group` exactly once (shared
 * ones included) and empty it. Safe to call twice.
 */
export function disposeGroup(group: Group): void {
  const resources = new Set<{ dispose(): void }>();
  group.traverse((object) => {
    if (!(object instanceof Mesh || object instanceof LineSegments)) return;
    resources.add(object.geometry);
    const materials: Material[] = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => resources.add(material));
  });
  resources.forEach((resource) => resource.dispose());
  group.clear();
}

// ── Camera ───────────────────────────────────────────────────────────────────

export type CameraPreset = "front" | "oblique" | "side";

export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
  distance: number;
}

/** Degrees round the vertical axis from the front, and up from the horizon. */
const PRESET_ANGLES: Readonly<Record<CameraPreset, { azimuth: number; elevation: number }>> = {
  front: { azimuth: 0, elevation: 0 },
  oblique: { azimuth: 35, elevation: 20 },
  side: { azimuth: 75, elevation: 10 },
};

/** Room around the cabinet, so the open leaves stay in frame too. */
const FIT_MARGIN = 1.2;
const ZOOM_STEP = 1.25;

/** How far back the camera stands so the whole cabinet fits a canvas of this aspect. */
export function fitDistance(size: { width: number; height: number; depth: number }, aspect: number, fovDeg: number): number {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const halfFov = Math.tan(((fovDeg / 2) * Math.PI) / 180);
  const span = Math.max(size.height / 2, size.width / 2 / safeAspect, size.depth / 2, 1);
  return (span / halfFov) * FIT_MARGIN + size.depth / 2;
}

/** Camera position for a preset, looking at the cabinet's centre. */
export function cameraPose(
  size: { width: number; height: number; depth: number },
  preset: CameraPreset,
  aspect: number,
  fovDeg: number,
): CameraPose {
  const distance = fitDistance(size, aspect, fovDeg);
  const { azimuth, elevation } = PRESET_ANGLES[preset];
  const az = (azimuth * Math.PI) / 180;
  const el = (elevation * Math.PI) / 180;
  return {
    position: [distance * Math.sin(az) * Math.cos(el), distance * Math.sin(el), distance * Math.cos(az) * Math.cos(el)],
    target: [0, 0, 0],
    distance,
  };
}

/** One press of + ("in") or − ("out"), kept inside the limits. */
export function stepDistance(distance: number, direction: "in" | "out", min: number, max: number): number {
  const next = direction === "in" ? distance / ZOOM_STEP : distance * ZOOM_STEP;
  return Math.min(max, Math.max(min, next));
}
