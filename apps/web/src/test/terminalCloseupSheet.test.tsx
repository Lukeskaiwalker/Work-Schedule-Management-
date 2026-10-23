/**
 * The close-up ("Nahansicht") of a field's two terminal rails
 * (docs/PANEL_ENCLOSURE_R2.md §7.2, §13, §14.3 "terminalCloseupSheet"):
 * both rails in ONE drawing in one scroller of its own, markers, levels and
 * "für" texts through the shared fit rule, a tap shows every text in full,
 * the strip buttons move whole strips, and the field's banners and "Ohne
 * Platz" carry the findings' actions.
 *
 * Invented boards only — the repo is public.
 */
import { describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { LONG_PRESS_MS } from "../components/schaltplan/enclosure/dragMachine";
import { TerminalCloseupSheet, type TerminalCloseupSheetProps } from "../components/schaltplan/enclosure/TerminalCloseupSheet";
import { CLOSEUP_FIT, MARKER_ZONE_PX, PX_PER_MM, closeupLayout } from "../components/schaltplan/enclosure/terminalCloseupLayout";
import { enclosureFindings } from "../utils/enclosureRules";
import { moveTerminalStrip } from "../utils/enclosureOpsTerminals";
import { boardTerminals, placeTerminals } from "../utils/enclosureTerminals";
import { terminalCloseup } from "../utils/enclosureTerminalCloseup";
import { terminalSuggestions } from "../utils/enclosureTerminalSuggest";
import { fitLabel } from "../utils/labelFit";
import type { CatalogIndex } from "../utils/enclosureCatalog";
import type { PanelDocument } from "../types/schaltplan";
import { FIXTURE_INDEX, boardDocument } from "./enclosureFixtureBoards";
import { doc, fi, lsRun, mod, range, row } from "./enclosureTerminalBoards";
import { INDEX } from "./enclosureTestCatalog";

const LONG_CABLE = "NYM-J 3x2,5 mm² über Keller, Hausanschlussraum links bis Küche";

/** Feld 1 (ZU37KS): F1, F2, F3 with two LS each on r3–r5 → X1–X3 on rail 1. F1.1 is on L2 with a long cable. */
function closeupBoard(): PanelDocument {
  const group = (g: number, first: number) => [fi(`dev-f${g}`, `F${g}`), ...lsRun(`f${g}`, `F${g}`, range(1, 3), first)];
  const rows = [row("row-a3", "F1 · Verteiler 3", group(1, 1)), row("row-a4", "F1 · Verteiler 4", group(2, 3)), row("row-a5", "F1 · Verteiler 5", group(3, 5))];
  const first = { ...rows[0], devices: rows[0].devices.map((device) => (device.id === "dev-f1-1" ? { ...device, phase: "L2" as const, cable: LONG_CABLE } : device)) };
  return doc("ZB33S", [mod("mod-a", "ZU37KS", 0, { r3: "row-a3", r4: "row-a4", r5: "row-a5" })], [first, ...rows.slice(1)]);
}

function setup(document: PanelDocument, field: number, overrides: Partial<TerminalCloseupSheetProps> = {}, index: CatalogIndex = INDEX) {
  const terms = boardTerminals(document, index);
  const placement = placeTerminals(document, index, terms);
  const closeup = terminalCloseup(document, index, terms, placement).find((candidate) => candidate.field === field)!;
  const props: TerminalCloseupSheetProps = {
    document,
    index,
    terms,
    closeup,
    placement,
    suggestions: terminalSuggestions(document, index, terms, placement),
    findings: enclosureFindings(document, index, { terms, placement }),
    readOnly: false,
    selectedStripId: null,
    onSelectStrip: vi.fn(),
    onMove: vi.fn(),
    onReset: vi.fn(),
    onRunSuggestion: vi.fn(),
    onOpenRail: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  return { ...render(<TerminalCloseupSheet {...props} />), props, closeup };
}

const sheet = (n: number) => screen.getByRole("dialog", { name: `Reihenklemmen · Feld ${n}` });

describe("TerminalCloseupSheet — the drawing", () => {
  it("draws both rails in one drawing, in one scroller, each with its heading and U84T state", () => {
    const { container } = setup(closeupBoard(), 0);
    const scrollers = container.querySelectorAll(".sp-term-scroll");
    expect(scrollers).toHaveLength(1);
    expect(scrollers[0].querySelectorAll("svg")).toHaveLength(1);
    const drawing = scrollers[0].querySelector("svg")!;
    expect(within(drawing as unknown as HTMLElement).getByText("Hutschiene 1 · F1 · Verteiler 1 · 90,5 von 210 mm")).toBeInTheDocument();
    expect(within(drawing as unknown as HTMLElement).getByText("Hutschiene 2 · F1 · Verteiler 2 · 0 von 210 mm")).toBeInTheDocument();
    // Strips on rail 1 need a U84T set; the empty rail 2 needs none.
    expect(within(drawing as unknown as HTMLElement).getAllByText("U84T: 1 Satz auf der Materialliste")).toHaveLength(1);
    // 5 px per mm: the 210 mm rail is 1050 px wide.
    expect(Number(drawing.getAttribute("width"))).toBeGreaterThanOrEqual(210 * PX_PER_MM);
  });

  it("says U84T ab Werk on an RK field", () => {
    setup(boardDocument("terminals_rk_zb53s"), 1, {}, FIXTURE_INDEX);
    expect(within(sheet(2)).getAllByText("U84T ab Werk").length).toBeGreaterThan(0);
  });

  it("fits every marker into its 40 px zone above the terminal by the shared rule", () => {
    const { container, closeup } = setup(closeupBoard(), 0);
    const items = closeup.rails[0].items.filter((item) => item.marker);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const expected = fitLabel(item.marker, { w: item.widthMm * PX_PER_MM - 2, h: MARKER_ZONE_PX - 6 }, CLOSEUP_FIT.marker, CLOSEUP_FIT.scale);
      const text = container.querySelector(`[data-marker-for="${item.stripId}#${item.offsetMm}"]`);
      expect(text, item.marker).not.toBeNull();
      expect(text!.textContent).toBe(expected.text);
      expect(text!.getAttribute("data-rotated")).toBe(String(expected.rotated));
    }
  });

  it("stacks the conductors as tags and cuts a long text with …, which a tap shows in full", () => {
    const { container, props } = setup(closeupBoard(), 0);
    const layout = closeupLayout(props.closeup);
    const item = layout.rails[0].items.find((candidate) => candidate.item.deviceId === "dev-f1-1")!;
    expect(item.item.levels).toEqual(["N", "L2", "PE"]);
    const group = container.querySelector(`[data-item="${item.key}"]`)!;
    expect(Array.from(group.querySelectorAll(".sp-term-level text")).map((node) => node.textContent)).toEqual(["N", "L2", "PE"]);
    expect(group.querySelector(".sp-term-cable")!.textContent).toMatch(/…$/);

    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^Klemme ${item.item.xLabel}\\.${item.position} `) }));
    const detail = screen.getByRole("region", { name: /^Klemme X1/ });
    expect(detail).toHaveTextContent(LONG_CABLE);
    expect(detail).toHaveTextContent("N · L2 · PE");
    expect(detail).toHaveTextContent(item.item.forText);
    expect(props.onSelectStrip).toHaveBeenCalledWith("dev-f1:leiste");
  });

  it("selects the terminal on a slow tap of an editable board too, as on a read-only one (R9, D16)", () => {
    vi.useFakeTimers();
    try {
      const { container, props } = setup(closeupBoard(), 0);
      const hit = screen.getAllByRole("button", { name: /^Klemme X1\./ })[1];
      const touch = { pointerId: 1, pointerType: "touch", button: 0, clientX: 60, clientY: 120 };
      fireEvent.pointerDown(hit, touch);
      act(() => vi.advanceTimersByTime(LONG_PRESS_MS + 150));
      fireEvent.pointerUp(hit, touch);
      // The click Mobile Safari sends after a long press is swallowed; the tap itself selects.
      fireEvent.click(hit, { clientX: 60, clientY: 120 });
      expect(screen.getByRole("region", { name: /^Klemme X1\./ })).toBeInTheDocument();
      expect(container.querySelectorAll(".sp-term-cards tr.is-selected")).toHaveLength(1);
      expect(props.onSelectStrip).toHaveBeenCalledWith("dev-f1:leiste");
    } finally {
      vi.useRealTimers();
    }
  });

  it("selects only the strip on a slow tap of the strip's own background", () => {
    vi.useFakeTimers();
    try {
      const { container, props } = setup(closeupBoard(), 0);
      const background = container.querySelector('[data-strip="dev-f2:leiste"] .sp-term-strip-hit')!;
      const touch = { pointerId: 1, pointerType: "touch", button: 0, clientX: 60, clientY: 120 };
      fireEvent.pointerDown(background, touch);
      act(() => vi.advanceTimersByTime(LONG_PRESS_MS + 150));
      fireEvent.pointerUp(background, touch);
      expect(props.onSelectStrip).toHaveBeenCalledWith("dev-f2:leiste");
      expect(screen.queryByRole("region", { name: /^Klemme / })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists a card per strip under the drawing and highlights the tapped terminal's row", () => {
    const { container } = setup(closeupBoard(), 0, { selectedStripId: "dev-f1:leiste" });
    const cards = container.querySelectorAll(".sp-term-cards .sp-terminal-group");
    expect(cards).toHaveLength(3);
    fireEvent.click(screen.getAllByRole("button", { name: /^Klemme X1\./ })[1]);
    expect(container.querySelectorAll(".sp-term-cards tr.is-selected")).toHaveLength(1);
  });
});

describe("TerminalCloseupSheet — moving strips", () => {
  it("moves the selected strip left, right and onto the other rail", () => {
    const { props } = setup(closeupBoard(), 0, { selectedStripId: "dev-f2:leiste" });
    fireEvent.click(screen.getByRole("button", { name: "Nach links" }));
    expect(props.onMove).toHaveBeenLastCalledWith("dev-f2:leiste", { field: 0, rail: 0, at: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Nach rechts" }));
    expect(props.onMove).toHaveBeenLastCalledWith("dev-f2:leiste", { field: 0, rail: 0, at: 2 });
    fireEvent.click(screen.getByRole("button", { name: "Auf Hutschiene 2" }));
    expect(props.onMove).toHaveBeenLastCalledWith("dev-f2:leiste", { field: 0, rail: 1, at: 0 });
    expect(screen.queryByRole("button", { name: "Auf Hutschiene 1" })).toBeNull();
  });

  it("offers Reihenfolge zurücksetzen only with a stored order", () => {
    setup(closeupBoard(), 0, { selectedStripId: "dev-f1:leiste" });
    expect(screen.queryByRole("button", { name: "Reihenfolge zurücksetzen" })).toBeNull();
    const result = moveTerminalStrip(closeupBoard(), INDEX, "dev-f1:leiste", { field: 0, rail: 1, at: 0 });
    if (!result.ok) throw new Error(result.error);
    cleanup();
    const { props } = setup(result.document, 0, { selectedStripId: "dev-f1:leiste" });
    expect(screen.getByRole("button", { name: "Auf Hutschiene 1" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reihenfolge zurücksetzen" }));
    expect(props.onReset).toHaveBeenCalledWith(0);
  });

  it("drags a strip with the mouse onto the other rail", () => {
    const { container, props } = setup(closeupBoard(), 0);
    const layout = closeupLayout(props.closeup);
    const source = container.querySelector('[data-drag-device="dev-f1:leiste"] .sp-term-hit')!;
    const rail2 = layout.rails[1];
    const mouse = { pointerId: 1, pointerType: "mouse", button: 0 };
    fireEvent.pointerDown(source, { ...mouse, clientX: 40, clientY: layout.rails[0].bodyY + 20 });
    fireEvent.pointerMove(source, { ...mouse, clientX: 40, clientY: rail2.bodyY + 20 });
    fireEvent.pointerUp(source, { ...mouse, clientX: 40, clientY: rail2.bodyY + 20 });
    expect(props.onMove).toHaveBeenCalledWith("dev-f1:leiste", { field: 0, rail: 1, at: 0 });
  });

  it("shows the drag label in a fixed layer on the page, never in the sheet's scrolling body", () => {
    const { container, props } = setup(closeupBoard(), 0);
    const layout = closeupLayout(props.closeup);
    const source = container.querySelector('[data-drag-device="dev-f1:leiste"] .sp-term-hit')!;
    const mouse = { pointerId: 1, pointerType: "mouse", button: 0 };
    fireEvent.pointerDown(source, { ...mouse, clientX: 40, clientY: layout.rails[0].bodyY + 20 });
    fireEvent.pointerMove(source, { ...mouse, clientX: 40, clientY: layout.rails[1].bodyY + 20 });
    const label = document.querySelector(".sp-encl-drag-label")!;
    expect(label).toHaveTextContent(/^X1 → Hutschiene 2/);
    expect(label.parentElement).toBe(document.body);
    expect(document.querySelector("body > .sp-encl-drag-ghost")).toHaveTextContent("X1");
    // The line in the sheet stays as the polite echo, for screen readers only.
    expect(container.querySelector(".sp-term-drag-label")).toHaveClass("visually-hidden");
    expect(container.querySelector(".sp-term-drag-label")).toHaveTextContent(/^X1 → Hutschiene 2/);
    fireEvent.pointerUp(source, { ...mouse, clientX: 40, clientY: layout.rails[1].bodyY + 20 });
    expect(document.querySelector(".sp-encl-drag-label")).toBeNull();
  });

  it("hides every editing button on a read-only board, but still shows the texts", () => {
    setup(boardDocument("terminals_zb34s"), 1, { readOnly: true, selectedStripId: "dev-f1:leiste" }, FIXTURE_INDEX);
    for (const name of ["Nach links", "Nach rechts", "Auf Hutschiene 2", "Vorschlag ausführen", "Platzhalter entfernen", "Reihenfolge zurücksetzen"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(within(sheet(2)).getAllByText("Diese Hutschiene ist für Reihenklemmen reserviert — Geräte tiefer setzen.")).toHaveLength(2);
  });
});

describe("TerminalCloseupSheet — banners and Ohne Platz", () => {
  it("banners a reserved rail with its devices: Vorschlag ausführen, Geräte bearbeiten, Platzhalter entfernen", () => {
    const { props } = setup(boardDocument("terminals_zb34s"), 1, {}, FIXTURE_INDEX);
    const banners = within(sheet(2)).getAllByRole("note");
    const first = banners.find((note) => note.textContent!.includes("F2 · Verteiler 1"))!;
    expect(first).toHaveTextContent("Diese Hutschiene ist für Reihenklemmen reserviert — Geräte tiefer setzen.");
    fireEvent.click(within(first).getByRole("button", { name: "Vorschlag ausführen" }));
    expect(props.onRunSuggestion).toHaveBeenCalledWith(expect.objectContaining({ kind: "relink_rows" }));
    fireEvent.click(within(first).getByRole("button", { name: "Geräte bearbeiten" }));
    expect(props.onOpenRail).toHaveBeenCalledWith("mod-k", "r1", null);
    fireEvent.click(within(sheet(2)).getByRole("button", { name: "Platzhalter entfernen" }));
    expect(props.onRunSuggestion).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "remove_placeholders" }));
  });

  it("lists the strips without place with the finding's sentence and its action", () => {
    const { props } = setup(boardDocument("terminals_overflow_zb32s"), 0, {}, FIXTURE_INDEX);
    const section = screen.getByRole("region", { name: "Ohne Platz" });
    expect(within(section).getByText(/^X5 · /)).toBeInTheDocument();
    expect(section).toHaveTextContent("Vorschlag: F5 mit 10 Stromkreis(en) nach F2 · Verteiler 3 verschieben.");
    fireEvent.click(within(section).getByRole("button", { name: "Vorschlag ausführen" }));
    expect(props.onRunSuggestion).toHaveBeenCalledWith(expect.objectContaining({ kind: "move_group", headId: "dev-f5" }));
  });

  it("says when a stored split was ignored, with Reihenfolge zurücksetzen", () => {
    const { props } = setup(boardDocument("terminals_rk_zb53s"), 1, {}, FIXTURE_INDEX);
    const banner = within(sheet(2)).getAllByRole("note").find((note) => note.textContent!.includes("passt nicht mehr"))!;
    expect(banner).toHaveTextContent("Feld 2: Die manuelle Aufteilung der Klemmleisten passt nicht mehr — automatisch verteilt.");
    fireEvent.click(within(banner).getByRole("button", { name: "Reihenfolge zurücksetzen" }));
    expect(props.onReset).toHaveBeenCalledWith(1);
  });

  it("says what appears in an empty field", () => {
    setup(boardDocument("terminals_zb34s"), 2, {}, FIXTURE_INDEX);
    expect(within(sheet(3)).getByText("Noch keine Reihenklemmen in Feld 3 — Stromkreise mit „Reihenklemme“ erscheinen hier.")).toBeInTheDocument();
  });

  it("names its assumptions in the legend", () => {
    setup(closeupBoard(), 0);
    expect(within(sheet(1)).getByText("Beschriftung oben gezeichnet (WAGO: Mitte/seitlich) · Abschlussplatte rechts angenommen")).toBeInTheDocument();
  });
});
