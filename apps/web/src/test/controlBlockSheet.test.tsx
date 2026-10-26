/**
 * The §14a sheet (docs/PANEL_ENCLOSURE_R4.md §8.2): its four states, the
 * drawing, the terminal rows (rename, colour, add, remove, reset), the rail,
 * wire, tube and length settings, the facts, the footer (print, remove →
 * restore) and a read-only board. Every change goes through the op runner,
 * as on the tab (the harness runs ops exactly the way the tab does).
 * Invented boards only — the repo is public.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";

import { ControlBlockSheet } from "../components/schaltplan/enclosure/ControlBlockSheet";
import { defaultControlBlock, storedBlock } from "../utils/enclosureControlBlock";
import type { ControlBlock, EnclosureModule } from "../types/panelEnclosure";
import type { PanelDocument } from "../types/schaltplan";
import { board, INDEX } from "./enclosureTestCatalog";
import { renderSheet } from "./enclosureSheetHarness";

const mod = (id: string, code: string, field: number): EnclosureModule => ({
  id, code, field, unit: 0, label: "", rails: {}, fittings: null, removed_fittings: [], meters: [],
});

const ABSENT = Symbol("absent");

function ehzBoard(block: unknown = defaultControlBlock(), modules = [mod("m1", "ZH3EH16", 0), mod("m2", "ZU37VT5APZ2", 1)]): PanelDocument {
  const doc = board([], { code: "ZB33S", modules });
  return block === ABSENT ? doc : { ...doc, enclosure: { ...doc.enclosure!, control_block: block as ControlBlock } };
}

function open(document: PanelDocument, extra: { readOnly?: boolean; onPrintWires?: () => void } = {}) {
  return renderSheet(document, ({ document: current, onOp }) => (
    <ControlBlockSheet
      document={current}
      index={INDEX}
      readOnly={extra.readOnly ?? false}
      onOp={onOp}
      onClose={vi.fn()}
      onPrintWires={extra.onPrintWires}
    />
  ));
}

const block = (doc: PanelDocument) => storedBlock(doc)!;
const textbox = (position: number) => screen.getByRole("textbox", { name: `Bezeichnung Klemme ${position}` });

describe("ControlBlockSheet — states 1 to 3", () => {
  it("says where the block goes when there is no meter field", () => {
    open(ehzBoard(ABSENT, [mod("m2", "ZU37VT5APZ2", 1)]));
    const dialog = screen.getByRole("dialog", { name: "§14a-Klemmleiste" });
    expect(within(dialog).getByText("Kein Zählerfeld im Schrank — die §14a-Klemmleiste sitzt im ersten Zählerfeld von links.")).toBeInTheDocument();
  });

  it("offers to create a missing block, then shows it", () => {
    const { current } = open(ehzBoard(ABSENT));
    expect(screen.getByText("Noch keine §14a-Klemmleiste.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "§14a-Klemmleiste anlegen" }));
    expect(block(current())).toEqual(defaultControlBlock());
    expect(screen.getByRole("dialog", { name: "§14a-Klemmleiste · Feld 1" })).toBeInTheDocument();
  });

  it("only reports a missing block on a read-only board", () => {
    open(ehzBoard(ABSENT), { readOnly: true });
    expect(screen.getByText("Keine §14a-Klemmleiste geplant.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "§14a-Klemmleiste anlegen" })).toBeNull();
  });

  it("brings a removed block back, and only on an editable board", () => {
    const removed = ehzBoard({ ...defaultControlBlock(), off: true });
    const { current, unmount } = open(removed);
    expect(screen.getByText("§14a-Klemmleiste entfernt — sie steht nicht auf der Materialliste.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "§14a-Klemmleiste wieder anlegen" }));
    expect(block(current()).off).toBe(false);
    unmount();
    open(removed, { readOnly: true });
    expect(screen.queryByRole("button", { name: "§14a-Klemmleiste wieder anlegen" })).toBeNull();
  });
});

describe("ControlBlockSheet — the block", () => {
  it("draws the block with every label and names the standard", () => {
    open(ehzBoard());
    const dialog = screen.getByRole("dialog", { name: "§14a-Klemmleiste · Feld 1" });
    expect(within(dialog).getByText("Steuersignal-Klemmleiste (BDEW / VDE-AR-N 4100)")).toBeInTheDocument();
    expect(within(dialog).getByRole("img", { name: "§14a-Klemmleiste: UNSM, 60%, 30%, 0%, UStve, Stve" })).toBeInTheDocument();
    expect(textbox(1)).toHaveValue("UNSM");
    expect(textbox(6)).toHaveValue("Stve");
  });

  it("renames as typed, keeps the typed text while focused, and warns when a label is too long to print", () => {
    const { current } = open(ehzBoard());
    fireEvent.change(textbox(1), { target: { value: "UN " } });
    expect(textbox(1)).toHaveValue("UN ");
    expect(block(current()).terminals[0].label).toBe("UN");
    fireEvent.change(textbox(1), { target: { value: "Wärmepumpe" } });
    expect(textbox(1)).toHaveAccessibleDescription("Zu lang für die senkrechte Beschriftung — kürzer schreiben.");
    fireEvent.blur(textbox(1));
    expect(textbox(1)).toHaveValue("Wärmepumpe");
    expect(textbox(1)).toHaveAttribute("maxLength", "12");
  });

  it("sets a wire colour from the list, capitalised", () => {
    const { current } = open(ehzBoard());
    const select = screen.getByRole("combobox", { name: "Aderfarbe Klemme 2" });
    expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Braun", "Schwarz", "Grau", "Rot", "Violett", "Weiß", "Orange", "Rosa",
    ]);
    fireEvent.change(select, { target: { value: "orange" } });
    expect(block(current()).terminals[1].color).toBe("orange");
  });

  it("adds and removes terminals, never the last one and never a 13th", () => {
    const { current } = open(ehzBoard({ ...defaultControlBlock(), terminals: [{ id: "t1", label: "A", color: "braun" }, { id: "t2", label: "B", color: "rot" }] }));
    fireEvent.click(screen.getByRole("button", { name: "Klemme 2 „B“ entfernen" }));
    expect(block(current()).terminals.map((t) => t.label)).toEqual(["A"]);
    const last = screen.getByRole("button", { name: "Klemme 1 „A“ entfernen" });
    expect(last).toBeDisabled();
    expect(last).toHaveAccessibleDescription("Mindestens eine Klemme bleibt — sonst die ganze §14a-Klemmleiste entfernen.");
    expect(screen.getByText("Mindestens eine Klemme bleibt — sonst die ganze §14a-Klemmleiste entfernen.")).toBeVisible();
    for (let i = 0; i < 11; i += 1) fireEvent.click(screen.getByRole("button", { name: "+ Klemme" }));
    expect(block(current()).terminals).toHaveLength(12);
    expect(screen.getByRole("button", { name: "+ Klemme" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "+ Klemme" })).toHaveAccessibleDescription("Höchstens 12 Klemmen.");
  });

  it("restores the six standard terminals after asking", () => {
    const { current } = open(ehzBoard({ ...defaultControlBlock(), terminals: [{ id: "t1", label: "A", color: "rosa" }] }));
    fireEvent.click(screen.getByRole("button", { name: "Standard wiederherstellen" }));
    const question = screen.getByRole("group", { name: "Bezeichnungen und Farben auf die sechs Standardklemmen zurücksetzen?" });
    fireEvent.click(within(question).getByRole("button", { name: "Ja, zurücksetzen" }));
    expect(block(current()).terminals).toEqual(defaultControlBlock().terminals);
  });

  it("pins a rail, changes the wire and the tube, and says when the tube is too narrow", () => {
    const { current } = open(ehzBoard());
    const rail = screen.getByRole("combobox", { name: "Hutschiene" });
    expect(within(rail).getAllByRole("option").map((option) => option.textContent)).toEqual(["Automatisch", "F1 · AAR 1", "F1 · AAR 2"]);
    fireEvent.change(rail, { target: { value: "aar2" } });
    expect(block(current()).rail).toBe("aar2");
    fireEvent.change(rail, { target: { value: "" } });
    expect(block(current()).rail).toBeNull();
    const tube = screen.getByRole("combobox", { name: "Schrumpfschlauch" });
    expect(within(tube).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "WAGO 211-502 (Ø 4,8 · 1–2,5 mm²)", "WAGO 211-501 (Ø 3,2 · 0,75–1 mm²)",
    ]);
    fireEvent.change(tube, { target: { value: "wago-211-501" } });
    expect(block(current()).label_material).toBe("wago-211-501");
    expect(screen.getByText("211-501 passt nur auf 0,75–1 mm² — für 2,5 mm² 211-502 wählen.")).toBeInTheDocument();
    const wire = screen.getByRole("combobox", { name: "Leitung" });
    expect(within(wire).getAllByRole("option").map((option) => option.textContent)).toEqual(["1,5 mm²", "2,5 mm²"]);
    fireEvent.change(wire, { target: { value: "1.5" } });
    expect(block(current()).wire_mm2).toBe(1.5);
    expect(screen.getByText("211-501 passt nur auf 0,75–1 mm² — für 1,5 mm² 211-502 wählen.")).toBeInTheDocument();
    expect(screen.getByText("Aderbeschriftung: WAGO 211-501, jede Bezeichnung zweimal")).toBeInTheDocument();
  });

  it("takes a length per wire with a comma, keeps the stored one on a bad entry, and clears back to the drawing", () => {
    const { current } = open(ehzBoard());
    const length = screen.getByRole("textbox", { name: "Länge je Ader" });
    expect(length).toHaveAttribute("inputMode", "decimal");
    expect(length.getAttribute("placeholder")).toMatch(/^≈ \d+(,\d)? m aus der Zeichnung$/);
    fireEvent.change(length, { target: { value: "4,5" } });
    fireEvent.blur(length);
    expect(block(current()).wire_length_m).toBe(4.5);
    expect(length).toHaveValue("4,5");
    fireEvent.change(length, { target: { value: "30" } });
    fireEvent.keyDown(length, { key: "Enter" });
    expect(block(current()).wire_length_m).toBe(4.5);
    expect(length).toHaveAccessibleDescription("Länge 0,5 bis 20 m — leer lassen für die Länge aus der Zeichnung.");
    fireEvent.change(length, { target: { value: "" } });
    fireEvent.blur(length);
    expect(block(current()).wire_length_m).toBeNull();
    expect(length).not.toHaveAccessibleDescription();
  });

  it("lists the facts the fitter cannot change here", () => {
    open(ehzBoard());
    for (const fact of [
      "Ziel: RfZ über dem Zähler (Feld 1)",
      "Gegenstück: Lüsterklemme 6-polig",
      "Versorgung der Klemmleiste: aus dem gemessenen Bereich (nicht automatisch geplant)",
      "Aderbeschriftung: WAGO 211-502, jede Bezeichnung zweimal",
      "2002-1671: 0,25–4 mm²; manche Netzbetreiber verlangen 0,14–1,5 mm² — TAB prüfen.",
    ]) {
      expect(screen.getByText(fact)).toBeInTheDocument();
    }
  });

  it("names the APZ as the target of a 3-Punkt block, and says when there is none", () => {
    const { unmount } = open(ehzBoard(defaultControlBlock(), [mod("m1", "ZH33X7", 0), mod("m2", "ZU37VT5APZ2", 1)]));
    expect(screen.getByText("Ziel: APZ (Feld 2)")).toBeInTheDocument();
    unmount();
    open(ehzBoard(defaultControlBlock(), [mod("m1", "ZH33X7", 0)]));
    expect(screen.getByText("Ziel fehlt")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Länge je Ader" })).toHaveAttribute("placeholder", "aus der Zeichnung");
  });

  it("prints the wire labels and removes the block after asking", () => {
    const onPrintWires = vi.fn();
    const { current } = open(ehzBoard(), { onPrintWires });
    fireEvent.click(screen.getByRole("button", { name: "Aderbeschriftung drucken" }));
    expect(onPrintWires).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "§14a-Klemmleiste entfernen" }));
    const question = screen.getByRole("group", { name: "§14a-Klemmleiste und ihre Materialzeilen entfernen?" });
    fireEvent.click(within(question).getByRole("button", { name: "Ja, entfernen" }));
    expect(block(current()).off).toBe(true);
    expect(screen.getByText("§14a-Klemmleiste entfernt — sie steht nicht auf der Materialliste.")).toBeInTheDocument();
  });

  it("disables every edit on a read-only board but still prints", () => {
    const onPrintWires = vi.fn();
    open(ehzBoard(), { readOnly: true, onPrintWires });
    for (const box of screen.getAllByRole("textbox")) expect(box).toBeDisabled();
    for (const select of screen.getAllByRole("combobox")) expect(select).toBeDisabled();
    for (const name of [/entfernen$/, "+ Klemme", "Standard wiederherstellen"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    const print = screen.getByRole("button", { name: "Aderbeschriftung drucken" });
    expect(print).toBeEnabled();
    fireEvent.click(print);
    expect(onPrintWires).toHaveBeenCalledTimes(1);
  });
});
