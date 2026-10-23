/**
 * The drop note (docs/PANEL_ENCLOSURE_R2.md §6.5): what a drop did, in
 * plain German — where the device went, which circuits now hang off another
 * Schutzgerät — and a one-step **Rückgängig** that restores the exact prior
 * document. One `mutate` per drop; a refusal says why and changes nothing;
 * any later edit takes the note away.
 *
 * Invented boards only — the repo is public.
 */
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { useCallback, useRef, useState } from "react";

import { DropNote } from "../components/schaltplan/enclosure/DropNote";
import { capNoteLines, describeDrop, UNDONE_TEXT } from "../components/schaltplan/enclosure/dropNoteText";
import { useDropUndo } from "../components/schaltplan/enclosure/useDropUndo";
import { dropDevice, type DropResult } from "../utils/enclosureOpsDrag";
import type { EnclosureModule } from "../types/panelEnclosure";
import type { PanelDevice, PanelDocument, PanelRow } from "../types/schaltplan";
import { board, deepFreeze, dev, INDEX, row } from "./enclosureTestCatalog";

const mod = (id: string, code: string, field: number, rails: Record<string, string>): EnclosureModule => ({
  id, code, field, unit: 0, label: "", rails, fittings: null, removed_fittings: [], meters: [],
});
const ls = (id: string, designation: string, extra: Partial<PanelDevice> = {}) => dev("mcb", { id, designation, ...extra });
const fi = (id: string, designation: string) => dev("rcd", { id, designation });

function base(patch: (rows: PanelRow[]) => PanelRow[] = (rows) => rows): PanelDocument {
  const rows = [
    row("v1", [fi("fi1", "F1"), ls("a1", "F1.1"), ls("a2", "F1.2"), ls("a3", "F1.3")], "F1 · Verteiler 1"),
    row("v2", [fi("fi2", "F2"), ls("b1", "F2.1"), ls("b2", "F2.2")], "F1 · Verteiler 2"),
    row("w1", [fi("fi3", "F3"), ls("c1", "F3.1")], "F2 · Verteiler 1"),
  ];
  return deepFreeze(board(patch(rows), { code: "ZB33S", modules: [mod("mv", "ZU37KS", 0, { r1: "v1", r2: "v2" }), mod("mw", "ZU37KS", 1, { r1: "w1" })] }));
}

function dropped(doc: PanelDocument, deviceId: string, moduleId: string, railKey: string, at: number) {
  const result = dropDevice(doc, INDEX, deviceId, { moduleId, railKey, at });
  if (!result.ok) throw new Error(result.error);
  return result.document;
}

describe("describeDrop", () => {
  it("says where the device went", () => {
    const before = base();
    const after = dropped(before, "a3", "mv", "r1", 1);
    expect(describeDrop(before, after, INDEX, "a3")).toEqual(["F1.3 verschoben: F1 · Verteiler 1, Platz 2."]);
  });

  it("names one changed feed with the old and the new Schutzgerät", () => {
    const before = base();
    const after = dropped(before, "a1", "mv", "r2", 1);
    expect(describeDrop(before, after, INDEX, "a1")).toEqual([
      "F1.1 verschoben: F1 · Verteiler 2, Platz 2.",
      "F1.1 hängt jetzt an F2 (vorher F1).",
    ]);
  });

  it("sums up several changed feeds, three by name", () => {
    const before = base((rows) => [rows[0], rows[1], { ...rows[2], devices: [rows[2].devices[0], ...["c1", "c2", "c3", "c4", "c5"].map((id, i) => ls(id, `F3.${i + 1}`))] }]);
    const after = dropped(before, "fi2", "mw", "r1", 1);
    expect(describeDrop(before, after, INDEX, "fi2")).toEqual([
      "F2 mit 2 Stromkreisen verschoben: F2 · Verteiler 1, Platz 2.",
      "5 Stromkreise hängen jetzt an einem anderen Schutzgerät: F3.1 F3 → F2, F3.2 F3 → F2, F3.3 F3 → F2 und 2 weitere.",
    ]);
  });

  it("calls the feed before the first Schutzgerät the Einspeisung", () => {
    const before = base();
    const after = dropped(before, "a1", "mv", "r1", 0);
    expect(describeDrop(before, after, INDEX, "a1")).toEqual(["F1.1 verschoben: F1 · Verteiler 1, Platz 1.", "F1.1 hängt jetzt an Einspeisung (vorher F1)."]);
  });

  it("caps a note at five lines", () => {
    expect(capNoteLines(["1", "2", "3", "4", "5"])).toEqual(["1", "2", "3", "4", "5"]);
    expect(capNoteLines(["1", "2", "3", "4", "5", "6", "7"])).toEqual(["1", "2", "3", "4", "5", "…"]);
  });
});

/** A stand-in for the editor: `mutate` applies a recipe and returns early on an unchanged board, as the real one does. */
function useFakeEditor(initial: PanelDocument, spy: () => void) {
  const [document, setDocumentState] = useState(initial);
  const ref = useRef(document);
  const setDocument = useCallback((next: PanelDocument) => {
    ref.current = next;
    setDocumentState(next);
  }, []);
  const mutate = useCallback(
    (recipe: (current: PanelDocument) => PanelDocument) => {
      spy();
      const next = recipe(ref.current);
      if (next !== ref.current) setDocument(next);
    },
    [spy, setDocument],
  );
  return { document, mutate, setDocument, spy };
}

function setup(initial = base()) {
  const spy = vi.fn<() => void>();
  return renderHook(() => {
    const editor = useFakeEditor(initial, spy);
    const drops = useDropUndo({ document: editor.document, mutate: editor.mutate });
    return { editor, drops };
  });
}

const move = (deviceId: string, moduleId: string, railKey: string, at: number) => (current: PanelDocument): DropResult =>
  dropDevice(current, INDEX, deviceId, { moduleId, railKey, at });
const describeFor = (deviceId: string) => (before: PanelDocument, after: PanelDocument) => describeDrop(before, after, INDEX, deviceId);

describe("useDropUndo", () => {
  it("applies a drop with one mutate and offers Rückgängig, which restores the exact prior document", () => {
    const start = base();
    const { result } = setup(start);
    act(() => result.current.drops.run(move("a1", "mv", "r2", 1), describeFor("a1")));
    expect(result.current.editor.spy).toHaveBeenCalledTimes(1);
    expect(result.current.drops.note).toEqual({ lines: ["F1.1 verschoben: F1 · Verteiler 2, Platz 2.", "F1.1 hängt jetzt an F2 (vorher F1)."], canUndo: true });

    act(() => result.current.drops.undo());
    expect(result.current.editor.document).toBe(start);
    expect(result.current.drops.note).toEqual({ lines: [UNDONE_TEXT], canUndo: false });
    expect(UNDONE_TEXT).toBe("Verschieben rückgängig gemacht.");
  });

  it("says a refusal and changes nothing", () => {
    const start = base((rows) => [rows[2], rows[0], rows[1]]);
    const { result } = setup(start);
    act(() => result.current.drops.run(move("a1", "mv", "r2", 1), describeFor("a1")));
    expect(result.current.editor.document).toBe(start);
    expect(result.current.drops.note).toEqual({ lines: ["Reihen sind nicht in Schrankreihenfolge — erst „Reihen ordnen“."], canUndo: false });
  });

  it("shows nothing for a drop that changed nothing", () => {
    const { result } = setup();
    act(() => result.current.drops.run(move("a2", "mv", "r1", 2), describeFor("a2")));
    expect(result.current.drops.note).toBeNull();
  });

  it("goes away with the next edit, and undo then does nothing", () => {
    const { result } = setup();
    act(() => result.current.drops.run(move("a1", "mv", "r2", 1), describeFor("a1")));
    const after = result.current.editor.document;
    const edited = { ...after, supply: { ...after.supply, fuse: "NH 63 A" } };
    act(() => result.current.editor.setDocument(edited));
    expect(result.current.drops.note).toBeNull();
    act(() => result.current.drops.undo());
    expect(result.current.editor.document).toBe(edited);
  });

  it("dismiss closes the note; remember offers undo for an op-runner action", () => {
    const start = base();
    const { result } = setup(start);
    act(() => result.current.drops.run(move("a1", "mv", "r2", 1), describeFor("a1")));
    act(() => result.current.drops.dismiss());
    expect(result.current.drops.note).toBeNull();

    const before = result.current.editor.document;
    const after = dropped(before, "b2", "mw", "r1", 0);
    act(() => result.current.editor.setDocument(after));
    act(() => result.current.drops.remember(before, after, ["Vorschlag ausgeführt."]));
    expect(result.current.drops.note).toEqual({ lines: ["Vorschlag ausgeführt."], canUndo: true });
    act(() => result.current.drops.undo());
    expect(result.current.editor.document).toBe(before);
  });
});

describe("DropNote", () => {
  it("is a polite status bar with Rückgängig and ×, both big enough for gloves", () => {
    const onUndo = vi.fn();
    const onDismiss = vi.fn();
    render(<DropNote note={{ lines: ["F1.1 verschoben: F1 · Verteiler 2, Platz 2."], canUndo: true }} onUndo={onUndo} onDismiss={onDismiss} />);
    const bar = screen.getByRole("status");
    expect(bar).toHaveAttribute("aria-live", "polite");
    expect(bar).toHaveTextContent("F1.1 verschoben: F1 · Verteiler 2, Platz 2.");
    fireEvent.click(screen.getByRole("button", { name: "Rückgängig" }));
    fireEvent.click(screen.getByRole("button", { name: "Hinweis schließen" }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Rückgängig" })).toHaveClass("sp-encl-target");
  });

  it("has no Rückgängig once undo is gone, and an empty live region without a note", () => {
    const { rerender } = render(<DropNote note={{ lines: [UNDONE_TEXT], canUndo: false }} onUndo={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Rückgängig" })).toBeNull();
    rerender(<DropNote note={null} onUndo={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });
});
