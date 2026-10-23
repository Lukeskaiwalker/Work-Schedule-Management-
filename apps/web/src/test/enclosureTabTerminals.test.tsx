/**
 * The WAGO terminal UI on the Schrank tab, end to end with the real editor
 * hook (docs/PANEL_ENCLOSURE_R2.md §7.2, §7.4, §6.5, §3.6, §14.3
 * "enclosureTabTerminals"):
 *
 *  - the close-up opens from the field bar ("Klemmen Feld {n} · {k} ohne
 *    Platz"), from a reserved rail's band and from a strip (selected);
 *  - a whole strip dragged in the drawing is one edit with the note and a
 *    Rückgängig that restores the exact prior document;
 *  - a finding's "Vorschlag ausführen" runs through the op runner: the
 *    vacate moves both reserved rows in ONE op, a feed change waits for
 *    "Trotzdem ausführen", and the note's Rückgängig undoes either;
 *  - "Platzhalter entfernen" with Rückgängig;
 *  - the reserved rails refuse a device drop; a dragged group's note says
 *    what it did to the X numbers and fields;
 *  - a read-only board still opens the close-up, with nothing to press.
 *
 * Invented boards only — the repo is public.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useLayoutEffect, useMemo } from "react";

vi.mock("../utils/schaltplanApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/schaltplanApi")>();
  return { ...actual, updatePanel: vi.fn() };
});

import { EnclosureTab } from "../components/schaltplan/enclosure/EnclosureTab";
import { DRAWING_PAD_PX, ENCLOSURE_ZOOM_STEPS, FIELD_HEADER_PX } from "../components/schaltplan/enclosure/enclosureFrontLayout";
import { usePanelDocumentEditor } from "../hooks/usePanelDocumentEditor";
import { catalogIndex, type CatalogIndex } from "../utils/enclosureCatalog";
import { buildEnclosureScene } from "../utils/enclosureGeometry";
import { placeTerminals } from "../utils/enclosureTerminals";
import { updatePanel } from "../utils/schaltplanApi";
import type { EnclosureCatalog, SceneBox } from "../types/panelEnclosure";
import type { PanelDocument, PanelPlan } from "../types/schaltplan";
import { FIXTURE_CATALOG, boardDocument } from "./enclosureFixtureBoards";
import { doc, fi, ls, lsRun, mod, range, row } from "./enclosureTerminalBoards";
import { testCatalog } from "./enclosureTestCatalog";

const PLAN = { id: 9, panel_number: "VT-0009", designation: "UV2", name: "Unterverteiler Werkstatt", status: "draft", revision: 1 } as unknown as PanelPlan;
const TEST_CATALOG = testCatalog();

/** Every board the editor held, in order: one entry per edit that changed something. */
const history: PanelDocument[] = [];

function Host({ initial, catalog, readOnly = false }: { initial: PanelDocument; catalog: EnclosureCatalog; readOnly?: boolean }) {
  const editor = usePanelDocumentEditor({ token: "t", readOnly, onSaved: () => undefined, setError: vi.fn() });
  const { load } = editor;
  useLayoutEffect(() => {
    load({ panelId: PLAN.id, document: initial });
  }, [load, initial]);
  const state = useMemo(() => ({ catalog, index: catalogIndex(catalog), loading: false, error: null, reload: async () => undefined }), [catalog]);
  if (editor.document && history[history.length - 1] !== editor.document) history.push(editor.document);
  if (!editor.document) return null;
  return <EnclosureTab token="t" panel={PLAN} editor={editor} catalog={state} readOnly={readOnly} onNotice={vi.fn()} onError={vi.fn()} />;
}

const current = () => history[history.length - 1];
const edits = (since: PanelDocument) => history.length - 1 - history.indexOf(since);
const note = () => document.querySelector(".sp-encl-dropnote") as HTMLElement | null;
const undo = () => fireEvent.click(within(note()!).getByRole("button", { name: "Rückgängig" }));
const sheet = (n: number) => screen.getByRole("dialog", { name: `Reihenklemmen · Feld ${n}` });

// jsdom has no layout: the drawing fits 0 px, so the tab starts at the smallest zoom step.
const ZOOM = ENCLOSURE_ZOOM_STEPS[0];
const client = (x: number, y: number) => ({ clientX: DRAWING_PAD_PX + x * ZOOM, clientY: FIELD_HEADER_PX + DRAWING_PAD_PX + y * ZOOM });
const mouse = { pointerId: 1, pointerType: "mouse", button: 0 };

function mouseDrag(source: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }) {
  fireEvent.pointerDown(source, { ...mouse, ...client(from.x, from.y) });
  fireEvent.pointerMove(source, { ...mouse, ...client(to.x, to.y) });
  act(() => vi.advanceTimersByTime(20));
  fireEvent.pointerUp(source, { ...mouse, ...client(to.x, to.y) });
}

function boxOf(board: PanelDocument, index: CatalogIndex, find: (box: SceneBox) => boolean): SceneBox {
  const box = buildEnclosureScene(board, index, "open")!.boxes.find(find);
  if (!box) throw new Error("box not in the scene");
  return box;
}

const strips = (board: PanelDocument, index: CatalogIndex, field: number) =>
  placeTerminals(board, index).fields.find((entry) => entry.field === field)!.rails.map((rail) => rail.strips.map((strip) => strip.xLabel));

const finding = (text: string) => screen.getAllByRole("listitem").find((item) => item.textContent?.includes(text))!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(updatePanel).mockReset();
  vi.mocked(updatePanel).mockResolvedValue(PLAN);
  history.length = 0;
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  vi.useRealTimers();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

describe("EnclosureTab — the close-up opens", () => {
  it("from the field bar, saying how many strips have no place", () => {
    render(<Host initial={boardDocument("terminals_zb34s")} catalog={FIXTURE_CATALOG} />);
    fireEvent.click(screen.getByRole("button", { name: "Klemmen Feld 2 · 3 ohne Platz" }));
    const closeup = sheet(2);
    const unplaced = within(closeup).getByRole("region", { name: "Ohne Platz" });
    for (const label of ["X4", "X5", "X6"]) expect(within(unplaced).getByRole("button", { name: new RegExp(`^${label}`) })).toBeInTheDocument();
    // A field without terminal rails (the meter field) has no such button.
    expect(screen.queryByRole("button", { name: /^Klemmen Feld 1/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Klemmen Feld 3" })).toBeInTheDocument();
  });

  it("from a reserved rail's band, and from a strip with that strip selected", () => {
    render(<Host initial={boardDocument("terminals_zb34s")} catalog={FIXTURE_CATALOG} />);
    fireEvent.click(screen.getByRole("button", { name: /^Hutschiene F2 · Verteiler 2 · für Reihenklemmen reserviert/ }));
    expect(sheet(2)).toBeInTheDocument();
    fireEvent.click(within(sheet(2)).getByRole("button", { name: "Schließen" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Klemmleiste X7 auf F4 · Verteiler 1" }));
    expect(within(sheet(4)).getByRole("button", { name: "Klemmleiste X7" })).toHaveAttribute("aria-pressed", "true");
    // A device on a reserved rail still opens its RailSheet, which offers nothing new there.
    fireEvent.click(within(sheet(4)).getByRole("button", { name: "Schließen" }));
    fireEvent.click(screen.getByRole("button", { name: "Gerät F1.1 auf F2 · Verteiler 1" }));
    const rail = screen.getByRole("dialog", { name: "F2 · Verteiler 1" });
    expect(within(rail).getByRole("note")).toHaveTextContent("Diese Hutschiene ist für Reihenklemmen reserviert — Geräte tiefer setzen.");
    expect(within(rail).queryByRole("button", { name: "+ Gerät" })).toBeNull();
  });
});

describe("EnclosureTab — moving a strip", () => {
  it("drags a whole strip in the drawing with one edit, and Rückgängig restores the exact prior document", () => {
    const initial = boardDocument("terminals_zb34s");
    render(<Host initial={initial} catalog={FIXTURE_CATALOG} />);
    const index = catalogIndex(FIXTURE_CATALOG);
    expect(strips(initial, index, 3)).toEqual([["X7", "X8", "X10"], ["X9", "X11", "X12"]]);
    const x10 = boxOf(initial, index, (box) => box.kind === "terminal_strip" && box.label === "X10");
    const x7 = boxOf(initial, index, (box) => box.kind === "terminal_strip" && box.label === "X7");
    const before = current();
    mouseDrag(
      screen.getByRole("button", { name: "Klemmleiste X10 auf F4 · Verteiler 1" }),
      { x: x10.x + x10.w / 2, y: x10.y + x10.h / 2 },
      { x: x7.x + 2, y: x7.y + x7.h / 2 },
    );
    expect(edits(before)).toBe(1);
    expect(strips(current(), index, 3)).toEqual([["X10", "X7", "X8"], ["X9", "X11", "X12"]]);
    expect(current().enclosure!.modules.find((module) => module.id === "mod-w")!.terminal_order).toBeTruthy();
    expect(note()).toHaveTextContent("X10 verschoben: Feld 4 · Hutschiene 1.");
    undo();
    expect(current()).toBe(initial);
  });

  it("moves the selected strip with the close-up's buttons, through the same note", () => {
    const initial = boardDocument("terminals_zb34s");
    render(<Host initial={initial} catalog={FIXTURE_CATALOG} />);
    fireEvent.click(screen.getByRole("button", { name: "Klemmen Feld 4" }));
    fireEvent.click(within(sheet(4)).getByRole("button", { name: "Klemmleiste X7" }));
    fireEvent.click(within(sheet(4)).getByRole("button", { name: "Nach rechts" }));
    expect(strips(current(), catalogIndex(FIXTURE_CATALOG), 3)[0]).toEqual(["X8", "X7", "X10"]);
    expect(note()).toHaveTextContent("X7 verschoben: Feld 4 · Hutschiene 1.");
    // The sheet stays open on the moved strip, and the stored order can be reset.
    expect(within(sheet(4)).getByRole("button", { name: "Klemmleiste X7" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(sheet(4)).getByRole("button", { name: "Reihenfolge zurücksetzen" }));
    expect(strips(current(), catalogIndex(FIXTURE_CATALOG), 3)[0]).toEqual(["X7", "X8", "X10"]);
    undo();
    expect(strips(current(), catalogIndex(FIXTURE_CATALOG), 3)[0]).toEqual(["X8", "X7", "X10"]);
  });
});

describe("EnclosureTab — a finding's action", () => {
  it("Vorschlag ausführen moves both reserved rows in one op, and Rückgängig restores the exact prior document", () => {
    const initial = boardDocument("terminals_zb34s");
    render(<Host initial={initial} catalog={FIXTURE_CATALOG} />);
    const before = current();
    fireEvent.click(within(finding("F2 · Verteiler 1: Hutschiene ist für Reihenklemmen reserviert")).getByRole("button", { name: "Vorschlag ausführen" }));
    expect(edits(before)).toBe(1);
    const modules = new Map(current().enclosure!.modules.map((module) => [module.id, module] as const));
    expect(modules.get("mod-rk")!.rails).toEqual({ r3: "row-old1", r4: "row-old2" });
    expect(Object.keys(modules.get("mod-k")!.rails ?? {})).not.toContain("r1");
    expect(Object.keys(modules.get("mod-k")!.rails ?? {})).not.toContain("r2");
    expect(note()).toHaveTextContent("Vorschlag ausgeführt: Reihen auf F3 · Verteiler 3 und F3 · Verteiler 4 umgehängt.");
    // The reserved-rail warnings are gone with the rows.
    expect(screen.queryByText(/Hutschiene ist für Reihenklemmen reserviert/)).toBeNull();
    undo();
    expect(current()).toBe(initial);
  });

  it("waits for Trotzdem ausführen when the vacate re-feeds a circuit, then offers Rückgängig", () => {
    // ZB32S. Feld 1 (ZU37KS): r1 = F0.1 before every FI (the Einspeisung's), r3 = FI F1 + F1.1, F1.2. Feld 2 empty.
    const initial = doc("ZB32S", [mod("mod-a", "ZU37KS", 0, { r1: "row-a1", r3: "row-a3" }), mod("mod-b", "ZU37KS", 1, {})], [
      row("row-a1", "F1 · Verteiler 1", [ls("dev-q", "F0.1", "9", "Außenlicht")]),
      row("row-a3", "F1 · Verteiler 3", [fi("dev-f1", "F1"), ...lsRun("f1", "F1", range(1, 3), 1)]),
    ]);
    render(<Host initial={initial} catalog={TEST_CATALOG} />);
    fireEvent.click(within(finding("F1 · Verteiler 1: Hutschiene ist für Reihenklemmen reserviert")).getByRole("button", { name: "Vorschlag ausführen" }));
    const confirm = screen.getByRole("alertdialog", { name: "Stromkreise ändern ihre Einspeisung" });
    expect(within(confirm).getByText("F0.1: Einspeisung → F1")).toBeInTheDocument();
    expect(current()).toBe(initial);
    expect(note()).toBeNull();
    fireEvent.click(within(confirm).getByRole("button", { name: "Trotzdem ausführen" }));
    expect(current().enclosure!.modules[0].rails).toEqual({ r3: "row-a3", r4: "row-a1" });
    expect(note()).toHaveTextContent("Vorschlag ausgeführt: Reihe auf F1 · Verteiler 4 umgehängt.");
    expect(note()).toHaveTextContent("F0.1 hängt jetzt an F1 (vorher Einspeisung).");
    undo();
    expect(current()).toBe(initial);
  });

  it("Platzhalter entfernen removes the hand-placed Reihenklemme, with Rückgängig", () => {
    const initial = boardDocument("terminals_zb34s");
    render(<Host initial={initial} catalog={FIXTURE_CATALOG} />);
    fireEvent.click(within(finding("1 Platzhalter-Reihenklemme(n)")).getByRole("button", { name: "Platzhalter entfernen" }));
    expect(current().rows.find((candidate) => candidate.id === "row-old2")!.devices.map((device) => device.id)).not.toContain("dev-pl1");
    expect(note()).toHaveTextContent("1 Platzhalter-Reihenklemme entfernt.");
    undo();
    expect(current()).toBe(initial);
  });

  it("runs the vacate from the close-up's banner too", () => {
    render(<Host initial={boardDocument("terminals_zb34s")} catalog={FIXTURE_CATALOG} />);
    fireEvent.click(screen.getByRole("button", { name: "Klemmen Feld 2 · 3 ohne Platz" }));
    const banner = within(sheet(2)).getAllByRole("note")[0];
    fireEvent.click(within(banner).getByRole("button", { name: "Vorschlag ausführen" }));
    expect(current().enclosure!.modules.find((module) => module.id === "mod-rk")!.rails).toEqual({ r3: "row-old1", r4: "row-old2" });
    expect(note()).toHaveTextContent("Vorschlag ausgeführt");
  });
});

/** ZB32S. Feld 1 (ZU37KS): r3 = F1 + 2 LS, r4 = F2 + 2 LS. Feld 2 (ZU37KS): r3 = F3 + 2 LS. X1–X3 in reading order. */
function threeGroups(): PanelDocument {
  const group = (g: number, first: number) => [fi(`dev-f${g}`, `F${g}`), ...lsRun(`f${g}`, `F${g}`, range(1, 3), first)];
  return doc("ZB32S", [mod("mod-a", "ZU37KS", 0, { r3: "row-a3", r4: "row-a4" }), mod("mod-b", "ZU37KS", 1, { r3: "row-b3" })], [
    row("row-a3", "F1 · Verteiler 3", group(1, 1)),
    row("row-a4", "F1 · Verteiler 4", group(2, 3)),
    row("row-b3", "F2 · Verteiler 3", group(3, 5)),
  ]);
}

describe("EnclosureTab — devices and the terminal rails", () => {
  it("refuses a device dropped onto a terminal rail: the label says why, nothing changes", () => {
    const initial = threeGroups();
    render(<Host initial={initial} catalog={TEST_CATALOG} />);
    const index = catalogIndex(TEST_CATALOG);
    const source = boxOf(initial, index, (box) => box.kind === "device" && box.deviceId === "dev-f1-2");
    const reserved = boxOf(initial, index, (box) => box.id === "rail:mod-b:r1");
    const target = screen.getByRole("button", { name: "Gerät F1.2 auf F1 · Verteiler 3" });
    fireEvent.pointerDown(target, { ...mouse, ...client(source.x + source.w / 2, source.y + source.h / 2) });
    fireEvent.pointerMove(target, { ...mouse, ...client(reserved.x + 20, reserved.y + reserved.h / 2) });
    act(() => vi.advanceTimersByTime(20));
    expect(document.querySelector(".sp-encl-drag-label")).toHaveTextContent("Reihenklemmen-Schiene — hier keine Geräte");
    fireEvent.pointerUp(target, { ...mouse, ...client(reserved.x + 20, reserved.y + reserved.h / 2) });
    expect(current()).toBe(initial);
    expect(note()).toBeNull();
  });

  it("says what a dragged group did to the X numbers and its strip's field", () => {
    const initial = threeGroups();
    render(<Host initial={initial} catalog={TEST_CATALOG} />);
    const index = catalogIndex(TEST_CATALOG);
    const head = boxOf(initial, index, (box) => box.kind === "device" && box.deviceId === "dev-f1");
    const empty = boxOf(initial, index, (box) => box.id === "rail:mod-b:r4");
    mouseDrag(
      screen.getByRole("button", { name: "Gerät F1 auf F1 · Verteiler 3" }),
      { x: head.x + head.w / 2, y: head.y + head.h / 2 },
      { x: empty.x + 20, y: empty.y + empty.h / 2 },
    );
    expect(note()).toHaveTextContent("F1 mit 2 Stromkreisen verschoben: F2 · Verteiler 4, Platz 1.");
    expect(note()).toHaveTextContent("Klemmen neu nummeriert: X1 → X3, X2 → X1, X3 → X2 — Beschriftung neu drucken.");
    expect(note()).toHaveTextContent("X3 jetzt in Feld 2.");
    undo();
    expect(current()).toBe(initial);
  });
});

describe("EnclosureTab — read-only board", () => {
  it("still opens the close-up, with nothing to press", () => {
    render(<Host initial={boardDocument("terminals_zb34s")} catalog={FIXTURE_CATALOG} readOnly />);
    expect(screen.queryByRole("button", { name: "Vorschlag ausführen" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Klemmen Feld 2 · 3 ohne Platz" }));
    const closeup = sheet(2);
    for (const name of ["Vorschlag ausführen", "Platzhalter entfernen", "Nach links", "Nach rechts"]) {
      expect(within(closeup).queryByRole("button", { name })).toBeNull();
    }
    expect(within(closeup).getByText("Ohne Platz")).toBeInTheDocument();
  });
});

describe("EnclosureTab — the inspector of a circuit the cabinet gives no terminal", () => {
  it("names the zone instead of offering the terminal checkbox, as the Plan tab's inspector does (§3.1)", () => {
    render(<Host initial={boardDocument("terminals_zb34s")} catalog={FIXTURE_CATALOG} />);
    fireEvent.click(screen.getByRole("button", { name: /^Gerät F0\.1 auf / }));
    const top = () => screen.getAllByRole("dialog").slice(-1)[0];
    const rail = top();
    fireEvent.click(within(rail).getByRole("button", { name: /^F0\.1/ }));
    const inspector = top();
    expect(inspector).toHaveTextContent("Im AAR keine Reihenklemme — nur in Verteilerfeldern.");
    expect(within(inspector).queryByRole("checkbox", { name: /Reihenklemme am Abgang/ })).toBeNull();
  });
});
