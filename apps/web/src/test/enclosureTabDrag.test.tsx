/**
 * Device drag on the Schrank tab, end to end with the real editor hook
 * (docs/PANEL_ENCLOSURE_R2.md §6.4, §6.5, §14.3 "enclosureTabDrag"): a drop
 * is one edit, the note says what moved and which circuits now hang off
 * another Schutzgerät, and **Rückgängig** restores the exact prior document
 * — also after the autosave landed, never after another edit. The RailPicker
 * runs the same drop: the sheets close and the same note appears.
 *
 * Invented boards only — the repo is public.
 */
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useLayoutEffect, useMemo } from "react";

vi.mock("../utils/schaltplanApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/schaltplanApi")>();
  return { ...actual, updatePanel: vi.fn() };
});

import { EnclosureTab } from "../components/schaltplan/enclosure/EnclosureTab";
import { DRAWING_PAD_PX, ENCLOSURE_ZOOM_STEPS, FIELD_HEADER_PX } from "../components/schaltplan/enclosure/enclosureFrontLayout";
import { AUTOSAVE_DELAY_MS, usePanelDocumentEditor } from "../hooks/usePanelDocumentEditor";
import { catalogIndex } from "../utils/enclosureCatalog";
import { feedMap } from "../utils/enclosureFeeds";
import { updatePanel } from "../utils/schaltplanApi";
import type { EnclosureModule } from "../types/panelEnclosure";
import type { PanelDocument, PanelPlan } from "../types/schaltplan";
import { board, dev, row, testCatalog } from "./enclosureTestCatalog";

const PLAN = { id: 7, panel_number: "VT-0007", designation: "UV1", name: "Unterverteiler Keller", status: "draft", revision: 1 } as unknown as PanelPlan;

const mod = (id: string, code: string, field: number, rails: Record<string, string>): EnclosureModule => ({
  id, code, field, unit: 0, label: "", rails, fittings: null, removed_fittings: [], meters: [],
});

/** ZB33S. Feld 1: r3 = FI F1, F1.1, F1.2; r4 = FI F2, F2.1. Feld 2: r3 = FI F3, F3.1 (r1/r2 are the terminal rails, R2). */
function initialBoard(): PanelDocument {
  return board(
    [
      row("v1", [dev("rcd", { id: "fi1", designation: "F1" }), dev("mcb", { id: "a1", designation: "F1.1" }), dev("mcb", { id: "a2", designation: "F1.2" })], "F1 · Verteiler 3"),
      row("v2", [dev("rcd", { id: "fi2", designation: "F2" }), dev("mcb", { id: "b1", designation: "F2.1" })], "F1 · Verteiler 4"),
      row("w1", [dev("rcd", { id: "fi3", designation: "F3" }), dev("mcb", { id: "c1", designation: "F3.1" })], "F2 · Verteiler 3"),
    ],
    { code: "ZB33S", modules: [mod("mv", "ZU37KS", 0, { r3: "v1", r4: "v2" }), mod("mw", "ZU37KS", 1, { r3: "w1" })] },
  );
}

const latest: { document: PanelDocument | null } = { document: null };

function Host({ initial }: { initial: PanelDocument }) {
  const editor = usePanelDocumentEditor({ token: "t", readOnly: false, onSaved: () => undefined, setError: vi.fn() });
  const { load } = editor;
  useLayoutEffect(() => {
    load({ panelId: PLAN.id, document: initial });
  }, [load, initial]);
  const catalog = useMemo(() => testCatalog(), []);
  const state = useMemo(() => ({ catalog, index: catalogIndex(catalog), loading: false, error: null, reload: async () => undefined }), [catalog]);
  latest.document = editor.document;
  if (!editor.document) return null;
  return <EnclosureTab token="t" panel={PLAN} editor={editor} catalog={state} readOnly={false} onNotice={vi.fn()} onError={vi.fn()} />;
}

const current = () => latest.document!;
// jsdom has no layout: the drawing fits 0 px, so the tab starts at the smallest zoom step.
const ZOOM = ENCLOSURE_ZOOM_STEPS[0];
const client = (x: number, y: number) => ({ clientX: DRAWING_PAD_PX + x * ZOOM, clientY: FIELD_HEADER_PX + DRAWING_PAD_PX + y * ZOOM });
const mouse = { pointerId: 1, pointerType: "mouse", button: 0 };

/** Drag F1.2 (feld 1, r3) behind F2.1 on r4: cabinet mm (141, 400) → (140, 550). */
function dragF12BehindF21() {
  const source = screen.getByRole("button", { name: "Gerät F1.2 auf F1 · Verteiler 3" });
  fireEvent.pointerDown(source, { ...mouse, ...client(141, 400) });
  fireEvent.pointerMove(source, { ...mouse, ...client(140, 550) });
  act(() => vi.advanceTimersByTime(20));
  fireEvent.pointerUp(source, { ...mouse, ...client(140, 550) });
}

const note = () => document.querySelector(".sp-encl-dropnote");

/** The stylesheet off disk: vitest runs with `css: false`, so a `?raw` CSS import is empty (see nodeBuiltins.d.ts). */
const TEST_DIR = (import.meta as unknown as { dirname: string }).dirname;
function dragStylesheet(): string {
  const text = readFileSync(`${TEST_DIR}/../styles/schaltplan-enclosure-drag.css`, "utf8");
  if (text.trim() === "") throw new Error("schaltplan-enclosure-drag.css came back empty");
  return text;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(updatePanel).mockReset();
  vi.mocked(updatePanel).mockResolvedValue(PLAN);
  latest.document = null;
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  vi.useRealTimers();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

describe("EnclosureTab — dragging a device", () => {
  it("drops with one edit, says what changed, and Rückgängig restores the exact prior document", () => {
    const initial = initialBoard();
    render(<Host initial={initial} />);
    dragF12BehindF21();

    expect(current().rows.find((r) => r.id === "v2")!.devices.map((d) => d.id)).toEqual(["fi2", "b1", "a2"]);
    expect(feedMap(current()).get("a2")).toBe("fi2");
    expect(note()).toHaveTextContent("F1.2 verschoben: F1 · Verteiler 4, Platz 3.");
    expect(note()).toHaveTextContent("F1.2 hängt jetzt an F2 (vorher F1).");
    act(() => vi.advanceTimersByTime(AUTOSAVE_DELAY_MS));
    expect(updatePanel).toHaveBeenCalledTimes(1);

    fireEvent.click(within(note() as HTMLElement).getByRole("button", { name: "Rückgängig" }));
    expect(current()).toBe(initial);
    expect(note()).toHaveTextContent("Verschieben rückgängig gemacht.");
    expect(within(note() as HTMLElement).queryByRole("button", { name: "Rückgängig" })).toBeNull();
  });

  it("still offers Rückgängig after the autosave landed", async () => {
    const initial = initialBoard();
    render(<Host initial={initial} />);
    dragF12BehindF21();
    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);
      await Promise.resolve();
    });
    expect(updatePanel).toHaveBeenCalledTimes(1);
    fireEvent.click(within(note() as HTMLElement).getByRole("button", { name: "Rückgängig" }));
    expect(current()).toBe(initial);
  });

  it("takes the note away with the next edit", () => {
    render(<Host initial={initialBoard()} />);
    dragF12BehindF21();
    expect(within(note() as HTMLElement).getByRole("button", { name: "Rückgängig" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Feld 2 · ZU37KS/ }));
    fireEvent.change(screen.getByLabelText("Bezeichnung des Feldes"), { target: { value: "Küche" } });
    expect(note()).toBeNull();
    expect(screen.queryByRole("button", { name: "Rückgängig" })).toBeNull();
  });

  it("sums up several re-hung circuits with the neutral 'Schutzgerät'", () => {
    const initial = board(
      [
        row("v1", [dev("rcd", { id: "fi1", designation: "F1" }), dev("mcb", { id: "a1", designation: "F1.1" })], "F1 · Verteiler 3"),
        row("v2", ["b1", "b2", "b3"].map((id, i) => dev("mcb", { id, designation: `F1.${i + 2}` })), "F1 · Verteiler 4"),
        row("w1", [dev("rcd", { id: "fi3", designation: "F3" })], "F2 · Verteiler 3"),
      ],
      { code: "ZB33S", modules: [mod("mv", "ZU37KS", 0, { r3: "v1", r4: "v2" }), mod("mw", "ZU37KS", 1, { r3: "w1" })] },
    );
    render(<Host initial={initial} />);
    // F3 (with no circuits of its own) to the start of r4: F1.2–F1.4 now hang off it.
    const source = screen.getByRole("button", { name: "Gerät F3 auf F2 · Verteiler 3" });
    fireEvent.pointerDown(source, { ...mouse, ...client(330, 400) });
    fireEvent.pointerMove(source, { ...mouse, ...client(46, 550) });
    act(() => vi.advanceTimersByTime(20));
    fireEvent.pointerUp(source, { ...mouse, ...client(46, 550) });
    expect(note()).toHaveTextContent("3 Stromkreise hängen jetzt an einem anderen Schutzgerät: F1.2 F1 → F3, F1.3 F1 → F3, F1.4 F1 → F3.");
  });
});

describe("EnclosureTab — Auf andere Hutschiene… runs the same drop", () => {
  it("closes the sheets and shows the note; Rückgängig works", () => {
    const initial = initialBoard();
    render(<Host initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Gerät F1.2 auf F1 · Verteiler 3" }));
    fireEvent.click(screen.getByRole("button", { name: /^F1\.2, Leitungsschutzschalter/ }));
    fireEvent.click(screen.getByRole("button", { name: "Auf andere Hutschiene…" }));
    const picker = screen.getByRole("dialog", { name: "Hutschiene wählen" });
    fireEvent.click(within(picker).getByRole("button", { name: /^Feld 1 · Verteiler 4 · / }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Wohin auf F1 · Verteiler 4?" })).getByRole("button", { name: "Am Ende" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelectorAll(".sp-sheet-backdrop")).toHaveLength(0);
    expect(note()).toHaveTextContent("F1.2 verschoben: F1 · Verteiler 4, Platz 3.");
    fireEvent.click(within(note() as HTMLElement).getByRole("button", { name: "Rückgängig" }));
    expect(current()).toBe(initial);
  });

  it("puts the note bar above an open sheet's backdrop", () => {
    render(<Host initial={initialBoard()} />);
    dragF12BehindF21();
    fireEvent.click(screen.getByRole("button", { name: "Hutschiene F1 · Verteiler 3 · 2 Geräte" }));
    const backdrop = document.querySelector(".sp-sheet-backdrop")!;
    const bar = note()!;
    // Portaled to the body, after the backdrop, and stacked over the sheets.
    expect(bar.closest('[role="status"]')!.parentElement).toBe(document.body);
    expect(backdrop.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(dragStylesheet()).toMatch(/\.sp-encl-dropnote\s*\{[^}]*z-index:\s*calc\(var\(--z-modal\)\s*\+\s*1\)/);
  });
});
