/**
 * The 3D scene graph of a cabinet (docs/PANEL_ENCLOSURE.md §12, §14
 * "enclosureThreeScene").
 *
 * The builder is pure three.js object construction — no renderer, no WebGL —
 * so it runs in jsdom. It draws the boxes `buildEnclosureScene` computed and
 * positions nothing of its own beyond the y-flip into three's y-up frame and
 * the door leaves' pivots.
 */
import { BufferGeometry, Group, LineSegments, Material, Mesh, Object3D, Raycaster, Vector3 } from "three";
import { describe, expect, it, vi } from "vitest";

import {
  buildThreeGroup,
  cameraPose,
  COVER_LAYER_KINDS,
  DOOR_OPEN_DEG,
  disposeGroup,
  doorHinge,
  setDoorOpen,
  stepDistance,
} from "../components/schaltplan/enclosure/enclosureThreeScene";
import type { EnclosureScene, SceneBox, SceneBoxKind } from "../types/panelEnclosure";
import { BOARD_NAMES, FIXTURE_BOARDS } from "./enclosureFixtureBoards";

function meshes(group: Object3D): Mesh[] {
  const found: Mesh[] = [];
  group.traverse((object) => {
    if (object instanceof Mesh) found.push(object);
  });
  return found;
}

function meshById(group: Object3D, id: string): Mesh {
  const mesh = meshes(group).find((candidate) => candidate.name === id);
  if (!mesh) throw new Error(`no mesh ${id}`);
  return mesh;
}

function worldCentre(object: Object3D): Vector3 {
  object.updateWorldMatrix(true, false);
  return object.getWorldPosition(new Vector3());
}

/** Where the centre of a scene box lands in three's frame: cabinet centred on the origin, y up. */
function expectedCentre(scene: EnclosureScene, box: SceneBox): Vector3 {
  return new Vector3(
    box.x + box.w / 2 - scene.width / 2,
    scene.height / 2 - (box.y + box.h / 2),
    box.z + box.d / 2 - scene.depth / 2,
  );
}

function sceneOf(name: string, view: "open" | "closed"): EnclosureScene {
  const scene = view === "open" ? FIXTURE_BOARDS[name].scene_open : FIXTURE_BOARDS[name].scene_closed;
  if (!scene) throw new Error(`${name} has no ${view} scene`);
  return scene;
}

const sceneBox = (id: string, kind: SceneBoxKind, rect: Partial<SceneBox>): SceneBox => ({
  id,
  kind,
  x: 0,
  y: 0,
  z: 0,
  w: 10,
  h: 10,
  d: 10,
  label: "",
  moduleId: null,
  railKey: null,
  rowId: null,
  deviceId: null,
  zoneType: null,
  flags: [],
  ...rect,
});

/** A synthetic three-leaf cabinet: geometry has no such catalogue entry, the renderer must still cope. */
function threeLeafScene(): EnclosureScene {
  const W = 900;
  const H = 1100;
  const D = 205;
  const leaf = W / 3;
  const boxes: SceneBox[] = [sceneBox("shell", "shell", { w: W, h: H, d: D })];
  for (let i = 0; i < 3; i += 1) {
    boxes.push(sceneBox(`door:${i}`, "door", { x: i * leaf, w: leaf, h: H, z: D, d: 2 }));
    const handleX = i === 0 ? leaf - 30 : i * leaf + 15;
    boxes.push(sceneBox(`handle:${i}`, "handle", { x: handleX, y: H / 2 - 60, w: 15, h: 120, z: D + 2, d: 20 }));
  }
  return { width: W, height: H, depth: D, view: "open", boxes };
}

describe("buildThreeGroup", () => {
  it.each(BOARD_NAMES)("%s (open): one mesh per box, named by the box id", (name) => {
    const scene = sceneOf(name, "open");
    const group = buildThreeGroup(scene, { doorOpen: true });
    const ids = meshes(group).map((mesh) => mesh.name).sort();
    expect(ids).toEqual(scene.boxes.map((box) => box.id).sort());
    disposeGroup(group);
  });

  it.each(BOARD_NAMES)("%s (closed): the cover layer is skipped, the interior stays open", (name) => {
    const scene = sceneOf(name, "closed");
    const group = buildThreeGroup(scene, { doorOpen: true });
    const expected = scene.boxes.filter((box) => !COVER_LAYER_KINDS.has(box.kind)).map((box) => box.id);
    expect(scene.boxes.length).toBeGreaterThan(expected.length);
    expect(meshes(group).map((mesh) => mesh.name).sort()).toEqual(expected.sort());
    disposeGroup(group);
  });

  it("names exactly the six cover-layer kinds", () => {
    expect([...COVER_LAYER_KINDS].sort()).toEqual(
      ["blind_plate", "cover", "cover_slot", "device_front", "meter_front", "window"].sort(),
    );
  });

  it("centres the cabinet on the origin and flips y: every box lands where the geometry put it", () => {
    const scene = sceneOf("meter_dist_zb33s", "open");
    const group = buildThreeGroup(scene, { doorOpen: false });
    for (const box of scene.boxes) {
      const centre = worldCentre(meshById(group, box.id));
      const expected = expectedCentre(scene, box);
      expect(centre.x, box.id).toBeCloseTo(expected.x, 6);
      expect(centre.y, box.id).toBeCloseTo(expected.y, 6);
      expect(centre.z, box.id).toBeCloseTo(expected.z, 6);
    }
    disposeGroup(group);
  });

  it("sizes each mesh like its box", () => {
    const scene = sceneOf("tall_zb54s", "open");
    const group = buildThreeGroup(scene, { doorOpen: false });
    const device = scene.boxes.find((box) => box.kind === "device")!;
    const mesh = meshById(group, device.id);
    mesh.geometry.computeBoundingBox();
    const size = mesh.geometry.boundingBox!.getSize(new Vector3());
    expect(size.x).toBeCloseTo(device.w, 6);
    expect(size.y).toBeCloseTo(device.h, 6);
    expect(size.z).toBeCloseTo(device.d, 6);
    disposeGroup(group);
  });

  it("carries the box's references on the mesh, for picking and tests", () => {
    const scene = sceneOf("meter_dist_zb33s", "open");
    const group = buildThreeGroup(scene, { doorOpen: true });
    const device = scene.boxes.find((box) => box.kind === "device")!;
    expect(meshById(group, device.id).userData).toMatchObject({
      boxId: device.id,
      kind: "device",
      deviceId: device.deviceId,
      moduleId: device.moduleId,
    });
    disposeGroup(group);
  });

  it("draws the shell as an open box: looking in from the front, the first wall hit is the back", () => {
    const scene = sceneOf("meter_dist_zb33s", "open");
    const group = buildThreeGroup(scene, { doorOpen: true });
    const shell = meshById(group, "shell");
    shell.updateWorldMatrix(true, true);
    const ray = new Raycaster(new Vector3(0, 0, scene.depth * 3), new Vector3(0, 0, -1));
    const hits = ray.intersectObject(shell, false);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].point.z).toBeLessThan(-scene.depth / 2 + 20);
    // …and from the side it is closed: a wall stops the ray at the outer face.
    const side = new Raycaster(new Vector3(scene.width * 3, 0, 0), new Vector3(-1, 0, 0));
    expect(side.intersectObject(shell, false)[0].point.x).toBeCloseTo(scene.width / 2, 3);
    disposeGroup(group);
  });

  it("shares one geometry per kind and size, and one material per colour", () => {
    const scene = sceneOf("meter_dist_zb33s", "open");
    const group = buildThreeGroup(scene, { doorOpen: true });
    const all = meshes(group);
    const geometries = new Set(all.map((mesh) => mesh.geometry));
    const materials = new Set(all.map((mesh) => mesh.material));
    expect(geometries.size).toBeLessThan(all.length);
    expect(materials.size).toBeLessThan(all.length);
    const rails = all.filter((mesh) => mesh.userData.kind === "rail");
    const sameSize = rails.filter((mesh) => mesh.geometry === rails[0].geometry);
    expect(sameSize.length).toBeGreaterThan(1);
    disposeGroup(group);
  });

  it("outlines modules, zones and devices only", () => {
    const scene = sceneOf("violations_zb34s", "open");
    const group = buildThreeGroup(scene, { doorOpen: true });
    for (const mesh of meshes(group)) {
      const outlined = mesh.children.some((child) => child instanceof LineSegments);
      expect(outlined, mesh.name).toBe(["module", "zone", "device"].includes(mesh.userData.kind));
    }
    disposeGroup(group);
  });

  it("colours an overflowing device apart from a fitting one", () => {
    const scene: EnclosureScene = {
      width: 100,
      height: 100,
      depth: 100,
      view: "open",
      boxes: [
        sceneBox("device:a", "device", { deviceId: "a" }),
        sceneBox("device:b", "device", { deviceId: "b", x: 10, flags: ["overflow"] }),
        sceneBox("device:c", "device", { deviceId: "c", x: 20 }),
      ],
    };
    const group = buildThreeGroup(scene, { doorOpen: true });
    expect(meshById(group, "device:a").material).toBe(meshById(group, "device:c").material);
    expect(meshById(group, "device:a").material).not.toBe(meshById(group, "device:b").material);
    disposeGroup(group);
  });

  it("skips boxes without a size and never throws on garbage numbers", () => {
    const scene: EnclosureScene = {
      width: 100,
      height: 100,
      depth: 100,
      view: "open",
      boxes: [
        sceneBox("zone:z:a", "zone", { w: 0 }),
        sceneBox("zone:z:b", "zone", { h: -4 }),
        sceneBox("zone:z:c", "zone", { d: Number.NaN }),
        sceneBox("zone:z:d", "zone", { x: Number.POSITIVE_INFINITY }),
        sceneBox("zone:z:e", "zone", {}),
      ],
    };
    const group = buildThreeGroup(scene, { doorOpen: true });
    expect(meshes(group).map((mesh) => mesh.name)).toEqual(["zone:z:e"]);
    disposeGroup(group);
  });

  it("builds an empty group from an empty scene", () => {
    const group = buildThreeGroup({ width: 0, height: 0, depth: 0, view: "open", boxes: [] }, { doorOpen: true });
    expect(meshes(group)).toEqual([]);
  });
});

describe("door leaves", () => {
  it("puts each leaf and its handle under one pivot on the leaf's outer edge", () => {
    const scene = sceneOf("meter_dist_zb33s", "open");
    const group = buildThreeGroup(scene, { doorOpen: false });
    for (const i of [0, 1]) {
      const door = meshById(group, `door:${i}`);
      const handle = meshById(group, `handle:${i}`);
      expect(door.parent).toBe(handle.parent);
      expect(door.parent).not.toBe(group);
      expect(door.parent!.userData.doorLeaf).toBe(i);
    }
    // Two leaves meet in the middle, so they hinge on the cabinet's sides.
    expect(meshById(group, "door:0").parent!.position.x).toBeCloseTo(-scene.width / 2, 6);
    expect(meshById(group, "door:1").parent!.position.x).toBeCloseTo(scene.width / 2, 6);
    disposeGroup(group);
  });

  it("hinges a single leaf on the left, opposite its handle", () => {
    const scene = sceneOf("removed_dangling_zb52s", "open");
    expect(scene.boxes.filter((box) => box.kind === "door")).toHaveLength(1);
    const group = buildThreeGroup(scene, { doorOpen: false });
    expect(meshById(group, "door:0").parent!.position.x).toBeCloseTo(-scene.width / 2, 6);
    disposeGroup(group);
  });

  it("swings every leaf 100° out toward the viewer, beyond its hinge", () => {
    expect(DOOR_OPEN_DEG).toBe(100);
    for (const scene of [sceneOf("meter_dist_zb33s", "open"), sceneOf("removed_dangling_zb52s", "open"), threeLeafScene()]) {
      const group = buildThreeGroup(scene, { doorOpen: true });
      for (const box of scene.boxes.filter((candidate) => candidate.kind === "door")) {
        const door = meshById(group, box.id);
        const pivot = door.parent!;
        const angle = (Math.abs(pivot.rotation.y) * 180) / Math.PI;
        expect(angle, box.id).toBeCloseTo(100, 6);
        const centre = worldCentre(door);
        expect(centre.z, box.id).toBeGreaterThan(scene.depth / 2 + box.w / 3);
        // Out past the hinge, never back across the cabinet front.
        const hingeX = pivot.position.x;
        if (hingeX < 0) expect(centre.x, box.id).toBeLessThan(hingeX);
        else expect(centre.x, box.id).toBeGreaterThan(hingeX);
      }
      disposeGroup(group);
    }
  });

  it("closes and reopens the leaves in place", () => {
    const scene = sceneOf("meter_dist_zb33s", "open");
    const group = buildThreeGroup(scene, { doorOpen: true });
    setDoorOpen(group, false);
    const door = scene.boxes.find((box) => box.id === "door:1")!;
    const closed = worldCentre(meshById(group, "door:1"));
    expect(closed.distanceTo(expectedCentre(scene, door))).toBeCloseTo(0, 6);
    setDoorOpen(group, true);
    expect(worldCentre(meshById(group, "door:1")).z).toBeGreaterThan(scene.depth);
    disposeGroup(group);
  });

  it("finds the hinge side of a leaf opposite its handle (three leaves: the middle one counts as right)", () => {
    expect(doorHinge(0, 1)).toBe("left");
    expect(doorHinge(0, 2)).toBe("left");
    expect(doorHinge(1, 2)).toBe("right");
    expect(doorHinge(0, 3)).toBe("left");
    expect(doorHinge(1, 3)).toBe("right");
    expect(doorHinge(2, 3)).toBe("right");
  });

  it("leaves a door without a parsable index flat in the group", () => {
    const scene: EnclosureScene = {
      width: 100,
      height: 100,
      depth: 10,
      view: "open",
      boxes: [sceneBox("door:x", "door", { w: 100, h: 100, z: 10, d: 2 }), sceneBox("handle:7", "handle", {})],
    };
    const group = buildThreeGroup(scene, { doorOpen: true });
    expect(meshById(group, "door:x").parent).toBe(group);
    expect(meshById(group, "handle:7").parent).toBe(group);
    disposeGroup(group);
  });
});

describe("disposeGroup", () => {
  it("disposes every geometry and material exactly once and empties the group", () => {
    const scene = sceneOf("violations_zb34s", "open");
    const group = buildThreeGroup(scene, { doorOpen: true });
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    group.traverse((object) => {
      if (object instanceof Mesh || object instanceof LineSegments) {
        geometries.add(object.geometry);
        const list = Array.isArray(object.material) ? object.material : [object.material];
        list.forEach((material: Material) => materials.add(material));
      }
    });
    expect(geometries.size).toBeGreaterThan(0);
    const spies = [...geometries, ...materials].map((resource) => vi.spyOn(resource, "dispose"));

    disposeGroup(group);
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
    expect(group.children).toEqual([]);

    disposeGroup(group);
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });

  it("copes with an empty group", () => {
    expect(() => disposeGroup(new Group())).not.toThrow();
  });
});

describe("cameraPose", () => {
  const cabinet = { width: 800, height: 1100, depth: 205 };

  it("looks straight at the front from the +z axis for Front", () => {
    const pose = cameraPose(cabinet, "front", 1.5, 35);
    expect(pose.position[0]).toBeCloseTo(0, 6);
    expect(pose.position[1]).toBeCloseTo(0, 6);
    expect(pose.position[2]).toBeGreaterThan(cabinet.depth);
    expect(pose.target).toEqual([0, 0, 0]);
  });

  it("backs off far enough that the cabinet height fits a landscape canvas and its width a portrait one", () => {
    const halfFov = ((35 / 2) * Math.PI) / 180;
    const wide = cameraPose(cabinet, "front", 2, 35);
    expect(wide.distance * Math.tan(halfFov)).toBeGreaterThan(cabinet.height / 2);
    const tall = cameraPose(cabinet, "front", 0.4, 35);
    expect(tall.distance * Math.tan(halfFov) * 0.4).toBeGreaterThan(cabinet.width / 2);
    expect(tall.distance).toBeGreaterThan(wide.distance);
  });

  it("swings to the right and up for Schräg, and further round for Seite", () => {
    const oblique = cameraPose(cabinet, "oblique", 1.5, 35);
    const side = cameraPose(cabinet, "side", 1.5, 35);
    expect(oblique.position[0]).toBeGreaterThan(0);
    expect(oblique.position[1]).toBeGreaterThan(0);
    expect(oblique.position[2]).toBeGreaterThan(0);
    expect(side.position[0]).toBeGreaterThan(Math.abs(side.position[2]));
    for (const pose of [oblique, side]) {
      expect(new Vector3(...pose.position).length()).toBeCloseTo(pose.distance, 6);
    }
  });

  it("never answers NaN for a degenerate canvas", () => {
    const pose = cameraPose(cabinet, "front", 0, 35);
    expect(pose.position.every(Number.isFinite)).toBe(true);
    expect(Number.isFinite(pose.distance)).toBe(true);
  });
});

describe("stepDistance", () => {
  it("moves in by a step for +, out for −, inside the limits", () => {
    expect(stepDistance(1000, "in", 100, 5000)).toBeCloseTo(800, 6);
    expect(stepDistance(1000, "out", 100, 5000)).toBeCloseTo(1250, 6);
    expect(stepDistance(110, "in", 100, 5000)).toBe(100);
    expect(stepDistance(4500, "out", 100, 5000)).toBe(5000);
  });
});

describe("imports (CSP: script-src 'self', worker-src 'self')", () => {
  const SOURCES = import.meta.glob("../**/*.{ts,tsx}", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;

  const THREE_FILES = [
    "../components/schaltplan/enclosure/Enclosure3DView.tsx",
    "../components/schaltplan/enclosure/Enclosure3DBoundary.tsx",
    "../components/schaltplan/enclosure/enclosureThreeScene.ts",
    "../components/schaltplan/enclosure/enclosureThreeStage.ts",
  ];

  // The glob keys files next to this test as "./…".
  const isTest = (path: string) => path.startsWith("./") || path.startsWith("../test/");
  /** Static `import … from` / `export … from` specifiers; type-only ones are erased by the compiler. */
  const staticImports = (source: string, { valuesOnly }: { valuesOnly: boolean }) =>
    [...source.matchAll(/(?:^|\n)\s*(import|export)(\s+type\b)?[^;]*?from\s*["']([^"']+)["']/g)]
      .filter((match) => !valuesOnly || !match[2])
      .map((match) => match[3]);
  const importsOf = (source: string) => staticImports(source, { valuesOnly: false });

  it("reads the 3D sources, so the scans below cannot pass vacuously", () => {
    for (const path of THREE_FILES) expect(SOURCES[path], path).toBeTruthy();
  });

  it("uses no loader, no wasm/worker helper, no worker, no OffscreenCanvas and no fetch", () => {
    for (const path of THREE_FILES) {
      const source = SOURCES[path];
      expect(source, path).not.toMatch(/three\/addons\/loaders|three\/addons\/libs|three\/examples/);
      expect(source, path).not.toMatch(/\bWorker\(|OffscreenCanvas|\bfetch\(|\beval\(|new Function\b/);
      for (const specifier of importsOf(source).filter((spec) => spec.startsWith("three"))) {
        expect(["three", "three/addons/controls/OrbitControls.js"], `${path}: ${specifier}`).toContain(specifier);
      }
    }
  });

  it("keeps three out of every file but the lazy 3D chunk's own", () => {
    const lazyChunk = new Set([
      "../components/schaltplan/enclosure/Enclosure3DView.tsx",
      "../components/schaltplan/enclosure/enclosureThreeScene.ts",
      "../components/schaltplan/enclosure/enclosureThreeStage.ts",
    ]);
    const offenders = Object.entries(SOURCES)
      .filter(([path]) => !isTest(path) && !lazyChunk.has(path))
      .filter(([, source]) => importsOf(source).some((spec) => spec === "three" || spec.startsWith("three/")))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("reaches the 3D view from outside only through a dynamic import()", () => {
    const lazyChunk = /(?:^|\/)(Enclosure3DView|enclosureThreeScene|enclosureThreeStage)(\.tsx?)?$/;
    const offenders = Object.entries(SOURCES)
      .filter(([path]) => !isTest(path) && !lazyChunk.test(path))
      .filter(([, source]) => staticImports(source, { valuesOnly: true }).some((spec) => lazyChunk.test(spec)))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
    expect(SOURCES["../components/schaltplan/enclosure/Enclosure3DBoundary.tsx"]).toMatch(/import\(\s*["']\.\/Enclosure3DView["']\s*\)/);
  });
});
