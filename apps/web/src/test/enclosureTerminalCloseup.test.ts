/**
 * The close-up ("Nahansicht") of a field's two terminal rails
 * (docs/PANEL_ENCLOSURE_R2.md §7.1) — the TS twin of
 * `apps/api/tests/test_panel_enclosure_terminal_closeup.py`.
 *
 * One pure layout for the app sheet and the PDF page: per terminal rail the
 * devices that still sit on it (back-compat, drawn grey), then every part of
 * every placed strip at its offset — each terminal with its marker, its
 * conductor levels top → bottom, the Klemmen tab's "für" text and the cable
 * — and the rail's end plate, before a trailing 2009-305. Python writes it
 * into `enclosureFixtures.json` (`terminal_closeup`); this twin must give
 * the same, number for number.
 */
import { describe, expect, it, vi } from "vitest";

import { boardTerminals, placeTerminals } from "../utils/enclosureTerminals";
import { rcdDetail, terminalCloseup, terminalForText } from "../utils/enclosureTerminalCloseup";
import type { TerminalCloseup } from "../types/panelEnclosure";
import type { PanelDocument } from "../types/schaltplan";
import { BOARD_NAMES, FIXTURE_BOARDS, FIXTURE_INDEX, boardDocument } from "./enclosureFixtureBoards";
import { doc, fi, ls, mod, row } from "./enclosureTerminalBoards";
import { deepFreeze } from "./enclosureTestCatalog";

function closeup(document: PanelDocument): TerminalCloseup[] {
  const terms = boardTerminals(document, FIXTURE_INDEX);
  return terminalCloseup(document, FIXTURE_INDEX, terms, placeTerminals(document, FIXTURE_INDEX, terms));
}

const fieldOf = (view: TerminalCloseup[], number: number): TerminalCloseup => view.find((field) => field.field === number)!;

describe("fixture parity", () => {
  it.each(BOARD_NAMES)("%s: the same close-up as Python", (name) => {
    expect(closeup(boardDocument(name))).toEqual(FIXTURE_BOARDS[name].terminal_closeup);
  });

  it("derives the terms and the placement itself when none are passed", () => {
    const document = boardDocument("terminals_zb34s");
    expect(terminalCloseup(document, FIXTURE_INDEX)).toEqual(FIXTURE_BOARDS.terminals_zb34s.terminal_closeup);
  });
});

describe("layout", () => {
  it("has one entry per field with terminal rails, both rails in order", () => {
    const view = closeup(boardDocument("meter_dist_zb33s"));
    expect(view.map((field) => field.field)).toEqual([1, 2]);
    const rails = fieldOf(view, 1).rails;
    expect(rails.map((r) => [r.railKey, r.position, r.title, r.capacityMm, r.usedMm, r.insulated])).toEqual([
      ["r1", 0, "F2 · Verteiler 1", 210, 30.7, false],
      ["r2", 1, "F2 · Verteiler 2", 210, 0, false],
    ]);
    expect(rails[1].items).toEqual([]);
    expect(rails[1].devices).toEqual([]);
    expect(fieldOf(view, 1).order).toBe("default");
    expect(fieldOf(view, 1).unplaced).toEqual([]);
  });

  it("lists every part of a Leiste with marker, levels, für text and cable; the plate before the 2009-305", () => {
    expect(fieldOf(closeup(boardDocument("meter_dist_zb33s")), 1).rails[0].items).toEqual([
      { kind: "terminal", partId: "2016-7714", partNo: "WAGO 2016-7714", stripId: "dev-f1:leiste", xLabel: "X1",
        offsetMm: 0, widthMm: 12, marker: "X1", levels: ["N"], forText: "FI F1 · 30 mA / Typ A", cable: "", deviceId: "dev-f1" },
      { kind: "terminal", partId: "2003-7641", partNo: "WAGO 2003-7641", stripId: "dev-f1:leiste", xLabel: "X1",
        offsetMm: 12, widthMm: 5.2, marker: "1.1", levels: ["N", "L", "PE"], forText: "F1.1 · Licht EG · Nr. 1",
        cable: "NYM-J 3x2,5 mm²", deviceId: "dev-f1-1" },
      { kind: "terminal", partId: "2003-7641", partNo: "WAGO 2003-7641", stripId: "dev-f1:leiste", xLabel: "X1",
        offsetMm: 17.2, widthMm: 5.2, marker: "1.2", levels: ["N", "L", "PE"], forText: "F1.2 · Steckdosen EG · Nr. 2",
        cable: "NYM-J 3x2,5 mm²", deviceId: "dev-f1-2" },
      { kind: "end_plate", partId: "2003-7692", partNo: "WAGO 2003-7692", stripId: null, xLabel: "",
        offsetMm: 22.4, widthMm: 0.8, marker: "", levels: [], forText: "", cable: "", deviceId: null },
      { kind: "end_clamp", partId: "2009-305", partNo: "WAGO 2009-305", stripId: "dev-f1:leiste", xLabel: "X1",
        offsetMm: 23.2, widthMm: 7.5, marker: "", levels: [], forText: "—", cable: "", deviceId: null },
    ]);
  });

  it("puts the end plate where the placement put it", () => {
    const document = boardDocument("terminals_zb34s");
    const terms = boardTerminals(document, FIXTURE_INDEX);
    const placement = placeTerminals(document, FIXTURE_INDEX, terms);
    const view = terminalCloseup(document, FIXTURE_INDEX, terms, placement);
    for (const field of placement.fields) {
      field.rails.forEach((rail, at) => {
        const plates = fieldOf(view, field.field).rails[at].items.filter((item) => item.kind === "end_plate");
        expect(plates.map((item) => [item.partId, item.offsetMm])).toEqual(rail.parts.map((part) => [part.partId, part.offsetMm]));
      });
    }
  });

  it("gives phases, three-pole outgoings and Blocks their levels", () => {
    const document = doc("ZB32S", [mod("mod-a", "ZU37KS", 0, { r3: "row-a" })], [
      row("row-a", "F1 · Verteiler 3", [
        fi("dev-f1", "F1"),
        ls("dev-l2", "F1.1", "1", "Licht", { phase: "L2", terminal_block: true }),
        ls("dev-3p", "F1.2", "2", "Motor", { poles: 3, te: 3, terminal_block: true }),
        ls("dev-b", "F1.3", "3", "Herd", { rating: "B20", poles: 3, te: 3, terminal_block: true }),
      ]),
    ]);
    const items = fieldOf(closeup(document), 0).rails[0].items;
    expect(items.map((item) => [item.partId, item.marker, item.levels])).toEqual([
      ["2016-7714", "X1", ["N"]],
      ["2003-7641", "1.1", ["N", "L2", "PE"]],
      ["2003-7641", "1.2", ["N", "L1", "PE"]],
      ["2003-7642", "1.3", ["L2", "L3"]],
      ["2009-305", "", []],
      // The Block, then its end plate (a rail ending in a 2016-76xx takes 2016-7691).
      ["2016-7604", "N", ["N"]],
      ["2016-7601", "L1", ["L1"]],
      ["2016-7601", "L2", ["L2"]],
      ["2016-7601", "L3", ["L3"]],
      ["2016-7607", "PE", ["PE"]],
      ["2016-7691", "", []],
    ]);
    expect(items.slice(4, 6).map((item) => item.kind)).toEqual(["end_clamp", "terminal"]);
    expect(items[items.length - 1]).toMatchObject({ kind: "end_plate", offsetMm: 95.1 }); // 35.1 mm Leiste + 60 mm Block
    expect(new Set(items.slice(5, 10).map((item) => item.xLabel))).toEqual(new Set(["X2"]));
  });

  it("draws the devices left on a reserved rail first and leaves the placeholders out", () => {
    const rails = fieldOf(closeup(boardDocument("terminals_zb34s")), 1).rails;
    expect(rails[1].devices).toEqual([
      { deviceId: "dev-f1-5", label: "F1.5", offsetMm: 0, widthMm: 17.5 },
      { deviceId: "dev-f1-6", label: "F1.6", offsetMm: 17.5, widthMm: 17.5 },
      { deviceId: "dev-f1-7", label: "F1.7", offsetMm: 35, widthMm: 17.5 },
    ]);
    expect(rails[1].items[0].offsetMm).toBe(52.5);
    expect(rails[0].devices.map((device) => device.label)).toEqual(["F1", "F1.1", "F1.2", "F1.3", "F1.4"]);
    expect(rails[0].devices[0].widthMm).toBe(70);
  });

  it("labels a device without a BMK by its catalogue short name", () => {
    const document = boardDocument("terminals_zb34s");
    const old1 = document.rows.find((candidate) => candidate.id === "row-old1")!;
    old1.devices[1] = { ...old1.devices[1], designation: "  " };
    expect(fieldOf(closeup(document), 1).rails[0].devices[1].label).toBe("LS");
  });

  it("lists the unplaced strips with their titles", () => {
    expect(fieldOf(closeup(boardDocument("terminals_zb34s")), 1).unplaced).toEqual([
      { stripId: "dev-f4:leiste", xLabel: "X4", title: "X4 · FI F4 · F2 · Verteiler 5", widthMm: 61.1 },
      { stripId: "dev-f5:leiste", xLabel: "X5", title: "X5 · FI F5 · F2 · Verteiler 6", widthMm: 61.1 },
      { stripId: "dev-f6:leiste", xLabel: "X6", title: "X6 · FI F6 · F2 · Verteiler 7", widthMm: 61.1 },
    ]);
  });

  it("echoes an insulated empty field and an ignored order", () => {
    const owner = fieldOf(closeup(boardDocument("terminals_zb34s")), 2);
    expect(owner.rails.map((rail) => rail.insulated)).toEqual([true, true]);
    expect(owner.rails.every((rail) => rail.items.length === 0)).toBe(true);
    expect(fieldOf(closeup(boardDocument("terminals_rk_zb53s")), 1).order).toBe("ignored");
  });

  it("shows the markers after the document's overrides", () => {
    const document = { ...boardDocument("meter_dist_zb33s"), terminal_labels: { "dev-f1-1:1": "Licht" } };
    expect(fieldOf(closeup(document), 1).rails[0].items.slice(0, 3).map((item) => item.marker)).toEqual(["X1", "Licht", "1.2"]);
  });
});

describe("the für text (the Klemmen tab's rule)", () => {
  it("names the FI with its type for the feed, the outgoing for its terminal and — for the end clamp", () => {
    const head = fi("dev-f1", "F1");
    const devices = new Map([["dev-f1-1", ls("dev-f1-1", "F1.1", "7", "Licht")]]);
    expect(rcdDetail(head)).toBe("30 mA / Typ A");
    expect(rcdDetail(ls("x", "F2", "", ""))).toBe("");
    expect(rcdDetail(fi("x", "F3", { rcd_type: "" }))).toBe("30 mA");
    expect(rcdDetail(null)).toBe("");
    expect(terminalForText({ partId: "2016-7714", deviceId: "dev-f1" }, devices, head)).toBe("FI F1 · 30 mA / Typ A");
    expect(terminalForText({ partId: "2016-7714", deviceId: "dev-f1" }, devices, fi("dev-f1", " "))).toBe("FI ? · 30 mA / Typ A");
    expect(terminalForText({ partId: "2016-7714", deviceId: null }, devices, null)).toBe("—");
    expect(terminalForText({ partId: "2003-7641", deviceId: "dev-f1-1" }, devices, head)).toBe("F1.1 · Licht · Nr. 7");
    expect(terminalForText({ partId: "2009-305", deviceId: null }, devices, head)).toBe("—");
    expect(terminalForText({ partId: "2003-7641", deviceId: "gone" }, devices, head)).toBe("—");
    expect(terminalForText({ partId: "2003-7641", deviceId: "x" }, new Map([["x", ls("x", "", "", "")]]), head)).toBe("—");
  });
});

describe("robustness", () => {
  it("has no close-up without a cabinet", () => {
    expect(closeup({ ...boardDocument("meter_dist_zb33s"), enclosure: null })).toEqual([]);
  });

  it.each<[string, unknown]>([
    ["an empty object", {}],
    ["broken modules", { ...doc("ZB33S", [], []), enclosure: { code: "ZB33S", modules: [null, 3, { id: 5 }] } }],
    ["a module of the wrong shape around a reserved row", {
      ...doc("ZB33S", [], [row("r", "", [ls("d1", "F1.1", "1", "x", { terminal_block: true, width_mm: Number.NaN })])]),
      enclosure: { code: "ZB33S", modules: [{ id: "m", code: "ZU37KS", field: "x", unit: null, rails: { r1: "r", r2: 7 } }] },
    }],
  ])("answers without a warning on %s", (_, garbage) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(Array.isArray(terminalCloseup(garbage as PanelDocument, FIXTURE_INDEX))).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("reads broken rows as Python does (the server never stores such rows)", () => {
    // Python's answer on the same document: the null row and the null device
    // are dropped, the id-less breaker still stands on the reserved rail.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const garbage = {
      enclosure: { code: "ZB33S", modules: [{ id: "m", code: "ZU37KS", field: 0, rails: { r1: "r" } }] },
      rows: [null, { id: "r", devices: [null, { kind: "mcb" }] }],
    };
    const rail = (railKey: string, position: number, usedMm: number) => ({
      moduleId: "m", railKey, title: `F1 · Verteiler ${position + 1}`, position, capacityMm: 210, usedMm, insulated: false, items: [],
    });
    expect(terminalCloseup(garbage as unknown as PanelDocument, FIXTURE_INDEX)).toEqual([{
      field: 0, order: "default", unplaced: [],
      rails: [
        { ...rail("r1", 0, 17.5), devices: [{ deviceId: "", label: "LS", offsetMm: 0, widthMm: 17.5 }] },
        { ...rail("r2", 1, 0), devices: [] },
      ],
    }]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("refuses terms that boardTerminals did not make", () => {
    const document = boardDocument("meter_dist_zb33s");
    const forged = { ...boardTerminals(document, FIXTURE_INDEX) };
    expect(() => terminalCloseup(document, FIXTURE_INDEX, forged)).toThrow(TypeError);
  });

  it("never mutates its inputs", () => {
    const document = deepFreeze(boardDocument("terminals_zb34s"));
    expect(() => closeup(document)).not.toThrow();
  });
});
