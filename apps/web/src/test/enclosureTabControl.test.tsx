/**
 * Round 4 on the Schrank tab (docs/PANEL_ENCLOSURE_R4.md §4, §5, §8.2, §8.4):
 * the finding's "§14a-Klemmleiste anlegen", the field bar's "§14a-Klemmen",
 * a tap on the block in the drawing, the leads in the open view, "Automatisch
 * ergänzt" with its overrides, and "Aderbeschriftung drucken" closing the
 * stack before the page's label dialog opens. Rendered with the real editor
 * hook (the save is mocked), as in enclosureTab.test.tsx.
 * Invented boards only — the repo is public.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useLayoutEffect, useMemo } from "react";

vi.mock("../utils/schaltplanApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/schaltplanApi")>();
  return { ...actual, updatePanel: vi.fn() };
});

import { EnclosureTab } from "../components/schaltplan/enclosure/EnclosureTab";
import { usePanelDocumentEditor } from "../hooks/usePanelDocumentEditor";
import { catalogIndex } from "../utils/enclosureCatalog";
import { defaultControlBlock, storedBlock } from "../utils/enclosureControlBlock";
import { updatePanel } from "../utils/schaltplanApi";
import type { ControlBlock, EnclosureModule } from "../types/panelEnclosure";
import type { PanelDocument, PanelPlan } from "../types/schaltplan";
import { board, testCatalog } from "./enclosureTestCatalog";

const PLAN = { id: 9, panel_number: "VT-0009", designation: "ZS1", name: "Zählerschrank Beispiel", status: "draft", revision: 1 } as unknown as PanelPlan;

const mod = (id: string, code: string, field: number): EnclosureModule => ({
  id, code, field, unit: 0, label: "", rails: {}, fittings: null, removed_fittings: [], meters: [],
});

const ABSENT = Symbol("absent");
const latest: { document: PanelDocument | null } = { document: null };

function meterBoard(block: unknown = defaultControlBlock()): PanelDocument {
  const doc = board([], { code: "ZB33S", modules: [mod("m1", "ZH3EH16", 0), mod("m2", "ZU37VT5APZ2", 1)] });
  return block === ABSENT ? doc : { ...doc, enclosure: { ...doc.enclosure!, control_block: block as ControlBlock } };
}

function Host({ initial, readOnly = false, onPrintWires }: { initial: PanelDocument; readOnly?: boolean; onPrintWires?: () => void }) {
  const editor = usePanelDocumentEditor({ token: "t", readOnly, onSaved: () => undefined, setError: vi.fn() });
  const { load } = editor;
  useLayoutEffect(() => {
    load({ panelId: PLAN.id, document: initial });
  }, [load, initial]);
  const catalog = useMemo(() => testCatalog(), []);
  const state = useMemo(() => ({ catalog, index: catalogIndex(catalog), loading: false, error: null, reload: async () => undefined }), [catalog]);
  latest.document = editor.document;
  if (!editor.document) return null;
  return (
    <EnclosureTab
      token="t"
      panel={PLAN}
      editor={editor}
      catalog={state}
      readOnly={readOnly}
      onNotice={vi.fn()}
      onError={vi.fn()}
      onPrintWires={onPrintWires}
    />
  );
}

const current = () => latest.document!;

beforeEach(() => {
  vi.mocked(updatePanel).mockReset();
  vi.mocked(updatePanel).mockResolvedValue(PLAN);
  latest.document = null;
});

describe("EnclosureTab — §14a block", () => {
  it("creates a missing block from the finding and opens its sheet", () => {
    render(<Host initial={meterBoard(ABSENT)} />);
    const findings = screen.getByRole("region", { name: "Hinweise zum Schrank" });
    expect(within(findings).getByText("Zählerschrank ohne §14a-Steuersignal-Klemmleiste: im ersten Zählerfeld anlegen.")).toBeInTheDocument();
    fireEvent.click(within(findings).getByRole("button", { name: "§14a-Klemmleiste anlegen" }));
    expect(storedBlock(current())).toEqual(defaultControlBlock());
    expect(screen.getByRole("dialog", { name: "§14a-Klemmleiste · Feld 1" })).toBeInTheDocument();
  });

  it("offers no action on a read-only board", () => {
    render(<Host initial={meterBoard(ABSENT)} readOnly />);
    const findings = screen.getByRole("region", { name: "Hinweise zum Schrank" });
    expect(within(findings).queryByRole("button", { name: "§14a-Klemmleiste anlegen" })).toBeNull();
    expect(screen.getByRole("button", { name: "§14a-Klemmen · fehlt" })).toBeInTheDocument();
  });

  it("opens the sheet from the field bar and from the block in the drawing", () => {
    render(<Host initial={meterBoard()} />);
    fireEvent.click(screen.getByRole("button", { name: "§14a-Klemmen · 6 Klemmen" }));
    expect(screen.getByRole("dialog", { name: "§14a-Klemmleiste · Feld 1" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Schließen" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "§14a-Klemmleiste, Feld 1, 6 Klemmen" }));
    expect(screen.getByRole("dialog", { name: "§14a-Klemmleiste · Feld 1" })).toBeInTheDocument();
  });

  it("renames through the op runner, so the board saves the change", () => {
    render(<Host initial={meterBoard()} />);
    fireEvent.click(screen.getByRole("button", { name: "§14a-Klemmen · 6 Klemmen" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Bezeichnung Klemme 2" }), { target: { value: "Stufe 1" } });
    expect(storedBlock(current())!.terminals[1].label).toBe("Stufe 1");
    expect(screen.getByRole("button", { name: "§14a-Klemmen · 6 Klemmen" })).toBeInTheDocument();
  });

  it("closes the stack before the label dialog opens for the wire labels", () => {
    const onPrintWires = vi.fn();
    render(<Host initial={meterBoard()} onPrintWires={onPrintWires} />);
    fireEvent.click(screen.getByRole("button", { name: "§14a-Klemmen · 6 Klemmen" }));
    fireEvent.click(screen.getByRole("button", { name: "Aderbeschriftung drucken" }));
    expect(onPrintWires).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelectorAll(".sp-sheet-backdrop")).toHaveLength(0);
  });

  it("draws the leads in the open view only", () => {
    const { container } = render(<Host initial={meterBoard()} />);
    expect(container.querySelectorAll("[data-run]").length).toBeGreaterThan(0);
    expect(container.querySelector('[data-run="control"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Geschlossen" }));
    expect(container.querySelectorAll("[data-run]")).toHaveLength(0);
  });
});

describe("EnclosureTab — Automatisch ergänzt", () => {
  it("lists the derived items under the findings and runs an override as an op", () => {
    const { container } = render(<Host initial={meterBoard()} />);
    const list = screen.getByRole("list", { name: "Automatisch ergänzt" });
    const findings = container.querySelector(".sp-encl-findings")!;
    expect(findings.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.change(within(list).getByRole("combobox", { name: "Spannungsversorgung" }), { target: { value: "off" } });
    expect(current().enclosure?.prep).toMatchObject({ supply: "off" });
    fireEvent.click(within(screen.getByRole("list", { name: "Automatisch ergänzt" })).getByRole("button", { name: "Wieder automatisch" }));
    expect(current().enclosure).not.toHaveProperty("prep");
  });

  it("keeps the choices disabled on a read-only board", () => {
    render(<Host initial={meterBoard()} readOnly />);
    for (const select of within(screen.getByRole("list", { name: "Automatisch ergänzt" })).getAllByRole("combobox")) {
      expect(select).toBeDisabled();
    }
  });
});
