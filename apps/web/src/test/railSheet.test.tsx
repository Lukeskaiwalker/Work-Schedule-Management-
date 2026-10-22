/**
 * One DIN rail as 56 px tiles (docs/PANEL_ENCLOSURE.md D15, D16, §11): the
 * tap target of the 2D view at every zoom. "+ Gerät" works on a rail that
 * has no row yet (the row is made on first use), "Aus Vorlage füllen" fills
 * an empty rail, and only distribution rails (VT/VF) offer to take an
 * existing row.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";

import { RailSheet } from "../components/schaltplan/enclosure/RailSheet";
import { linkedRows } from "../utils/enclosureLayout";
import { addDeviceToRail, placeModule } from "../utils/enclosureOps";
import { catalogIndex } from "../utils/enclosureCatalog";
import { board, dev, INDEX, MODULES, row, testCatalog } from "./enclosureTestCatalog";
import { renderSheet } from "./enclosureSheetHarness";
import type { DeviceKind, PanelDocument } from "../types/schaltplan";

function place(document: PanelDocument, code: string, field: number, claim = false): { document: PanelDocument; id: string } {
  const result = placeModule(document, INDEX, { code, field, unit: 0, claim });
  if (!result.ok) throw new Error(result.error);
  return { document: result.document, id: result.moduleId! };
}

const cabinet = (rows = board([]).rows): PanelDocument => board(rows, { code: "ZB33S", modules: [] });

type Extra = {
  highlight?: string | null;
  readOnly?: boolean;
  onOpenDevice?: (deviceId: string) => void;
  chooseKind?: DeviceKind;
};

function open(document: PanelDocument, moduleId: string, railKey: string, extra: Extra = {}) {
  const onOpenDevice = extra.onOpenDevice ?? vi.fn();
  const onChooseDevice = vi.fn((request: { label: string; pick: (kind: DeviceKind) => void }) => {
    if (extra.chooseKind) request.pick(extra.chooseKind);
  });
  const harness = renderSheet(document, ({ document: current, onOp, onEdit }) => (
    <RailSheet
      document={current}
      index={INDEX}
      moduleId={moduleId}
      railKey={railKey}
      highlightDeviceId={extra.highlight ?? null}
      readOnly={extra.readOnly ?? false}
      onOp={onOp}
      onEdit={onEdit}
      onOpenDevice={onOpenDevice}
      onChooseDevice={onChooseDevice}
      onClose={vi.fn()}
    />
  ));
  return { ...harness, onOpenDevice, onChooseDevice };
}

const railRow = (document: PanelDocument, moduleId: string, railKey: string) => {
  const rowId = document.enclosure!.modules.find((module) => module.id === moduleId)!.rails[railKey];
  return document.rows.find((candidate) => candidate.id === rowId) ?? null;
};

describe("RailSheet — an empty rail", () => {
  it("is titled by its place and shows its capacity", () => {
    const { document, id } = place(cabinet(), "ZU37KS", 1);
    open(document, id, "r2");
    const dialog = screen.getByRole("dialog", { name: "F2 · Verteiler 2" });
    expect(dialog).toHaveTextContent("0 / 12 PLE");
    expect(dialog).toHaveTextContent("ZU37KS");
  });

  it("+ Gerät on a rail without a row creates the row and opens the new device", () => {
    const { document, id } = place(cabinet(), "ZU37KS", 1);
    expect(railRow(document, id, "r1")).toBeNull();
    const { current, onChooseDevice, onOpenDevice } = open(document, id, "r1", { chooseKind: "mcb" });
    fireEvent.click(screen.getByRole("button", { name: "+ Gerät" }));
    expect(onChooseDevice).toHaveBeenCalledWith(expect.objectContaining({ label: "F2 · Verteiler 1" }));
    const created = railRow(current(), id, "r1");
    expect(created?.label).toBe("F2 · Verteiler 1");
    expect(created?.devices.map((device) => device.kind)).toEqual(["mcb"]);
    expect(onOpenDevice).toHaveBeenCalledWith(created!.devices[0].id);
    const track = screen.getByRole("list", { name: "Geräte auf der Hutschiene" });
    expect(within(track).getByRole("button", { name: /Leitungsschutzschalter/ })).toBeInTheDocument();
  });

  it("fills an empty rail from a template, sized to the rail", () => {
    const { document, id } = place(cabinet(), "ZU37KS", 1);
    const { current } = open(document, id, "r1");
    fireEvent.click(screen.getByRole("button", { name: "Aus Vorlage füllen" }));
    expect(screen.queryByRole("button", { name: /Leere Reihe/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /1 FI \+ 6 LS/ }));
    const filled = railRow(current(), id, "r1")!;
    expect(filled.label).toBe("F2 · Verteiler 1");
    expect(filled.slots).toBe(12);
    expect(filled.devices.map((device) => device.kind)).toEqual(["rcd", "mcb", "mcb", "mcb", "mcb", "mcb", "mcb"]);
    // A rail that holds something is not filled again.
    expect(screen.queryByRole("button", { name: "Aus Vorlage füllen" })).toBeNull();
  });

  it("offers outside rows only on distribution rails", () => {
    const outside = cabinet([row("alt", [dev("mcb", { id: "c1", designation: "F9.1" })], "Altbestand"), row("leer", [])]);
    const meter = place(outside, "ZH3EH16", 0);
    const dist = place(meter.document, "ZU37KS", 1);

    // The RfZ is empty too, but no place for a customer's breakers.
    const rfz = open(dist.document, meter.id, "rfz");
    expect(screen.getByRole("button", { name: "Aus Vorlage füllen" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Vorhandene Reihe hier einhängen" })).toBeNull();
    rfz.unmount();

    const { current } = open(dist.document, dist.id, "r1");
    fireEvent.click(screen.getByRole("button", { name: "Vorhandene Reihe hier einhängen" }));
    // Rows without devices are nothing to hang.
    expect(screen.queryByRole("button", { name: /^leer/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Altbestand · 1 Gerät/ }));
    expect(linkedRows(current(), INDEX).get("alt")).toEqual({ moduleId: dist.id, railKey: "r1" });
  });
});

describe("RailSheet — a rail with devices", () => {
  function filled() {
    const { document, id } = place(cabinet(), "ZU37KS", 1);
    const first = addDeviceToRail(document, INDEX, id, "r1", "rcd");
    if (!first.ok) throw new Error(first.error);
    const second = addDeviceToRail(first.document, INDEX, id, "r1", "mcb");
    if (!second.ok) throw new Error(second.error);
    return { document: second.document, id, fi: first.deviceId!, ls: second.deviceId! };
  }

  it("shows each device as a tile that opens the inspector, the tapped one highlighted", () => {
    const { document, id, fi, ls } = filled();
    const { onOpenDevice } = open(document, id, "r1", { highlight: ls });
    const track = screen.getByRole("list", { name: "Geräte auf der Hutschiene" });
    const tiles = within(track).getAllByRole("button");
    expect(tiles).toHaveLength(2);
    expect(tiles[1]).toHaveAttribute("aria-current", "true");
    expect(tiles[0]).not.toHaveAttribute("aria-current");
    fireEvent.click(tiles[0]);
    expect(onOpenDevice).toHaveBeenCalledWith(fi);
    expect(screen.getByRole("dialog")).toHaveTextContent("5 / 12 PLE");
  });

  it("scrolls the tapped device's tile to the middle of the track, which is wider than the sheet", () => {
    const scrolled: { element: Element; options: unknown }[] = [];
    Element.prototype.scrollIntoView = vi.fn(function (this: Element, options?: unknown) {
      scrolled.push({ element: this, options });
    });
    try {
      const { document, id, ls } = filled();
      open(document, id, "r1", { highlight: ls });
      const tiles = within(screen.getByRole("list", { name: "Geräte auf der Hutschiene" })).getAllByRole("button");
      expect(scrolled).toEqual([{ element: tiles[1], options: { block: "nearest", inline: "center" } }]);
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("scrolls nothing when no device was tapped", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      const { document, id } = filled();
      open(document, id, "r1");
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("marks pre-fitted parts", () => {
    const { document, id } = place(cabinet(), "ZH3EH16", 0);
    open(document, id, "aar1");
    const track = screen.getByRole("list", { name: "Geräte auf der Hutschiene" });
    expect(within(track).getByRole("button", { name: /Hauptschalter/ })).toHaveTextContent("vorbestückt");
  });

  it("renames the rail's row", () => {
    const { document, id } = filled();
    const { current } = open(document, id, "r1");
    const name = screen.getByRole("textbox", { name: "Name der Reihe" });
    fireEvent.change(name, { target: { value: "Küche" } });
    expect(railRow(current(), id, "r1")!.label).toBe("Küche");
  });

  it("read-only shows the tiles and no edit", () => {
    const { document, id } = filled();
    open(document, id, "r1", { readOnly: true });
    expect(screen.queryByRole("button", { name: "+ Gerät" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Aus Vorlage füllen" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Name der Reihe" })).toBeDisabled();
    expect(within(screen.getByRole("list", { name: "Geräte auf der Hutschiene" })).getAllByRole("button")).toHaveLength(2);
  });

  it("offers nothing new on a retired rail that still holds devices", () => {
    const { document, id } = filled();
    const retired = {
      ...MODULES.ZU37KS,
      zones: MODULES.ZU37KS.zones.map((zone) => ({ ...zone, rails: zone.rails.map((rail) => (rail.key === "r1" ? { ...rail, retired: true } : rail)) })),
    };
    const index = catalogIndex(testCatalog({ modules: { ZU37KS: retired } }));
    renderSheet(
      document,
      ({ document: current, onOp, onEdit }) => (
        <RailSheet
          document={current}
          index={index}
          moduleId={id}
          railKey="r1"
          highlightDeviceId={null}
          readOnly={false}
          onOp={onOp}
          onEdit={onEdit}
          onOpenDevice={vi.fn()}
          onChooseDevice={vi.fn()}
          onClose={vi.fn()}
        />
      ),
      index,
    );
    expect(screen.getByRole("dialog")).toHaveTextContent("ausgemustert — Geräte umsetzen");
    expect(screen.queryByRole("button", { name: "+ Gerät" })).toBeNull();
    expect(within(screen.getByRole("list", { name: "Geräte auf der Hutschiene" })).getAllByRole("button")).toHaveLength(2);
  });

  it("names a busbar rail as such", () => {
    const { document, id } = place(cabinet(), "ZH3EH16", 0);
    open(document, id, "nar");
    expect(screen.getByRole("dialog", { name: "F1 · NAR" })).toHaveTextContent("Sammelschiene");
  });

  it("says so when the rail is gone", () => {
    open(cabinet(), "mod-weg", "r1");
    expect(screen.getByText("Diese Hutschiene gibt es im Schrank nicht mehr.")).toBeInTheDocument();
  });
});
