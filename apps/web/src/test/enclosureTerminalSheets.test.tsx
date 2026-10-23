/**
 * The terminal parts of the Schrank tab's smaller pieces
 * (docs/PANEL_ENCLOSURE_R2.md §7.2, §7.4, §2.2, §3.6, §8, §13):
 *
 *  - the field bar's "Klemmen Feld {n}" (+ " · {k} ohne Platz"), only for
 *    fields with terminal rails;
 *  - a finding with an action: a 56 px button under its text;
 *  - RailSheet on a reserved rail: the banner, its action, no "+ Gerät" and
 *    no template;
 *  - ModuleSheet: "U84T ab Werk" from the SERVED spec, also for a module
 *    placed before round 2 whose snapshot lacks the fitting;
 *  - the 3D scene: a strip has a colour of its own.
 *
 * Invented boards only — the repo is public.
 */
import { MeshLambertMaterial, Mesh } from "three";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { EnclosureFieldBar } from "../components/schaltplan/enclosure/EnclosureFieldBar";
import { EnclosureFindings } from "../components/schaltplan/enclosure/EnclosureFindings";
import { ModuleSheet } from "../components/schaltplan/enclosure/ModuleSheet";
import { RailSheet } from "../components/schaltplan/enclosure/RailSheet";
import { buildThreeGroup, disposeGroup } from "../components/schaltplan/enclosure/enclosureThreeScene";
import { catalogIndex } from "../utils/enclosureCatalog";
import { buildEnclosureScene } from "../utils/enclosureGeometry";
import type { EnclosureModule } from "../types/panelEnclosure";
import type { PanelDocument, PanelFinding } from "../types/schaltplan";
import { FIXTURE_CATALOG, FIXTURE_INDEX, boardDocument } from "./enclosureFixtureBoards";
import { renderSheet } from "./enclosureSheetHarness";
import { dev, doc, fi, lsRun, mod, range, row } from "./enclosureTerminalBoards";
import { INDEX } from "./enclosureTestCatalog";

describe("EnclosureFieldBar — Klemmen Feld {n}", () => {
  const terminals = [
    { field: 1, unplaced: 3 },
    { field: 2, unplaced: 0 },
  ];

  it("offers the close-up per field with terminal rails, with the strips without place", () => {
    const onOpenTerminals = vi.fn();
    render(
      <EnclosureFieldBar
        document={boardDocument("terminals_zb34s")}
        index={FIXTURE_INDEX}
        onOpenModule={vi.fn()}
        onAddModule={vi.fn()}
        readOnly
        terminals={terminals}
        onOpenTerminals={onOpenTerminals}
      />,
    );
    const field2 = screen.getByRole("group", { name: "Feld 2" });
    fireEvent.click(within(field2).getByRole("button", { name: "Klemmen Feld 2 · 3 ohne Platz" }));
    expect(onOpenTerminals).toHaveBeenCalledWith(1);
    expect(within(screen.getByRole("group", { name: "Feld 3" })).getByRole("button", { name: "Klemmen Feld 3" })).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Feld 1" })).queryByRole("button", { name: /^Klemmen/ })).toBeNull();
  });
});

describe("EnclosureFindings — actions", () => {
  const findings: PanelFinding[] = [
    { level: "warn", rule: "encl.terminal_rail_devices", scope: "row-1", message: "F1 · Verteiler 1: Hutschiene ist für Reihenklemmen reserviert — 1 Gerät(e) tiefer setzen." },
    { level: "info", rule: "encl.terminals", scope: "", message: "Feld 1: 3 Reihenklemmen auf den oberen Hutschienen, 30,7 von 210 mm belegt." },
  ];

  it("puts the action's button on the finding whose (rule, scope) it is keyed by", () => {
    const run = vi.fn();
    render(<EnclosureFindings findings={findings} actions={new Map([["encl.terminal_rail_devices|row-1", { label: "Vorschlag ausführen", run }]])} />);
    const items = screen.getAllByRole("listitem");
    fireEvent.click(within(items[0]).getByRole("button", { name: "Vorschlag ausführen" }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(within(items[1]).queryByRole("button")).toBeNull();
  });

  it("has no buttons without actions", () => {
    render(<EnclosureFindings findings={findings} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

/** ZB32S. Feld 1 (ZU37KS): r1 holds Q9 (reserved), r3 holds F1 + 2 LS. Feld 2 empty. */
function reservedBoard(): PanelDocument {
  return doc("ZB32S", [mod("mod-a", "ZU37KS", 0, { r1: "row-a1", r3: "row-a3" }), mod("mod-b", "ZU37KS", 1, {})], [
    row("row-a1", "F1 · Verteiler 1", [dev("old1", "mcb", { designation: "Q9" })]),
    row("row-a3", "F1 · Verteiler 3", [fi("dev-f1", "F1"), ...lsRun("f1", "F1", range(1, 3), 1)]),
  ]);
}

function railSheet(railKey: string, extra: Partial<Parameters<typeof RailSheet>[0]> = {}) {
  const onChooseDevice = vi.fn();
  const harness = renderSheet(reservedBoard(), ({ document, onOp, onEdit }) => (
    <RailSheet
      document={document}
      index={INDEX}
      moduleId="mod-a"
      railKey={railKey}
      highlightDeviceId={null}
      readOnly={false}
      onOp={onOp}
      onEdit={onEdit}
      onOpenDevice={vi.fn()}
      onChooseDevice={onChooseDevice}
      onClose={vi.fn()}
      {...extra}
    />
  ));
  return { ...harness, onChooseDevice };
}

describe("RailSheet on a terminal rail", () => {
  it("warns on a reserved rail with devices, offers its action and the close-up, and no + Gerät", () => {
    const run = vi.fn();
    const onOpenTerminals = vi.fn();
    railSheet("r1", { reserved: true, reservedAction: { label: "Vorschlag ausführen", run }, onOpenTerminals });
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("Diese Hutschiene ist für Reihenklemmen reserviert — Geräte tiefer setzen.");
    fireEvent.click(within(note).getByRole("button", { name: "Vorschlag ausführen" }));
    expect(run).toHaveBeenCalledTimes(1);
    fireEvent.click(within(note).getByRole("button", { name: "Klemmen Feld 1" }));
    expect(onOpenTerminals).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "+ Gerät" })).toBeNull();
    // The devices still open their inspector (tolerated, §3.6).
    expect(screen.getByRole("button", { name: /^Q9/ })).toBeInTheDocument();
  });

  it("offers neither + Gerät nor a template on an empty reserved rail", () => {
    railSheet("r2", { reserved: true });
    expect(screen.getByRole("note")).toHaveTextContent("Diese Hutschiene ist für Reihenklemmen reserviert.");
    expect(screen.queryByRole("button", { name: "+ Gerät" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Aus Vorlage füllen" })).toBeNull();
  });

  it("is unchanged on an ordinary rail", () => {
    railSheet("r4");
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.getByRole("button", { name: "+ Gerät" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aus Vorlage füllen" })).toBeInTheDocument();
  });
});

describe("ModuleSheet — U84T ab Werk", () => {
  function moduleSheet(module: EnclosureModule) {
    const document = doc("ZB33S", [module], []);
    return renderSheet(
      document,
      ({ document: current, onOp, onEdit }) => (
        <ModuleSheet document={current} index={FIXTURE_INDEX} moduleId={module.id} readOnly={false} draft={false} onOp={onOp} onEdit={onEdit} onClose={vi.fn()} />
      ),
      FIXTURE_INDEX,
    );
  }

  it("reads the served spec, so a module placed before round 2 (no u84t in its snapshot) says it too", () => {
    expect(FIXTURE_CATALOG.modules.find((entry) => entry.code === "ZU37RK")?.spec?.fittings.some((fitting) => fitting.key === "u84t")).toBe(true);
    moduleSheet({ ...mod("mod-rk", "ZU37RK", 0, {}), fittings: [] });
    expect(screen.getByText("U84T ab Werk")).toBeInTheDocument();
  });

  it("says nothing for a field without it", () => {
    moduleSheet(mod("mod-k", "ZU37KS", 0, {}));
    expect(screen.queryByText("U84T ab Werk")).toBeNull();
  });
});

describe("3D: a strip is drawn in its own colour", () => {
  it("gives a terminal_strip box a material of its own, not the fallback", () => {
    const board = boardDocument("terminals_zb34s");
    const scene = buildEnclosureScene(board, catalogIndex(FIXTURE_CATALOG), "open")!;
    const group = buildThreeGroup(scene, { doorOpen: true });
    const strip = scene.boxes.find((box) => box.kind === "terminal_strip")!;
    let mesh: Mesh | null = null;
    group.traverse((object) => {
      if (object instanceof Mesh && object.name === strip.id) mesh = object;
    });
    const colour = ((mesh as unknown as Mesh).material as MeshLambertMaterial).color.getHex();
    expect(colour).not.toBe(0xdddddd);
    disposeGroup(group);
  });
});
