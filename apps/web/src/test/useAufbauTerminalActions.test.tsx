/**
 * "Vorschlag ausführen" on the Aufbau tab, the hook alone
 * (docs/PANEL_ENCLOSURE_R2.md §4.2, §6.5, §9, slice W4b): a reserved rail's
 * row offers the finding's suggestion, keyed `${rule}|${scope}` as on the
 * Schrank tab, run through an op runner of its own — C§2.4 pins, and
 * RegroupConfirm behind one backdrop when a feed would change — and then
 * the drop note with its one-step **Rückgängig**. The real editor hook
 * holds the board, so undo is checked by identity. The page tests
 * (schaltplanEnclosurePage.test.tsx) drive the banner's button. Invented
 * boards only — the repo is public.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useLayoutEffect } from "react";

vi.mock("../utils/schaltplanApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/schaltplanApi")>();
  return { ...actual, updatePanel: vi.fn() };
});

import { useAufbauTerminalActions } from "../components/schaltplan/enclosure/useAufbauTerminalActions";
import type { FindingAction } from "../components/schaltplan/enclosure/EnclosureFindings";
import { useBoardTerminals } from "../hooks/useBoardTerminals";
import { usePanelDocumentEditor } from "../hooks/usePanelDocumentEditor";
import type { CatalogIndex } from "../utils/enclosureCatalog";
import { feedMap } from "../utils/enclosureFeeds";
import { updatePanel } from "../utils/schaltplanApi";
import type { PanelDocument, PanelPlan } from "../types/schaltplan";
import { mod } from "./enclosureAufbauBoards";
import { boardDocument, FIXTURE_INDEX } from "./enclosureFixtureBoards";
import { board, dev, INDEX, row } from "./enclosureTestCatalog";

const PLAN = { id: 7, panel_number: "VT-0007", designation: "UV1", name: "Unterverteiler Keller", status: "draft", revision: 1 } as unknown as PanelPlan;

const latest: { document: PanelDocument | null; actions: ReadonlyMap<string, FindingAction> } = { document: null, actions: new Map() };
const onError = vi.fn();
const onNotice = vi.fn();

type HostProps = { initial: PanelDocument; index: CatalogIndex; readOnly?: boolean; catalogLoaded?: boolean };

function Host({ initial, index, readOnly = false, catalogLoaded = true }: HostProps) {
  const editor = usePanelDocumentEditor({ token: "t", readOnly, onSaved: () => undefined, setError: vi.fn() });
  const { load } = editor;
  useLayoutEffect(() => {
    load({ panelId: PLAN.id, document: initial });
  }, [load, initial]);
  const catalogue = catalogLoaded ? index : null;
  const boardTerminals = useBoardTerminals(editor.document, catalogue);
  const terminals = useAufbauTerminalActions({
    document: editor.document,
    index: catalogue,
    boardTerminals,
    readOnly,
    mutate: editor.mutate,
    onError,
    onNotice,
  });
  latest.document = editor.document;
  latest.actions = terminals.actions;
  return terminals.overlay;
}

const current = () => latest.document!;
const note = () => window.document.querySelector(".sp-encl-dropnote") as HTMLElement | null;
const railsOf = (document: PanelDocument, moduleId: string) => document.enclosure?.modules.find((module) => module.id === moduleId)?.rails;
const run = (key: string) => act(() => latest.actions.get(key)!.run());

/**
 * A ZB33S whose ZU37KS (field 2) has an LS on its first rail, straight off
 * the Einspeisung, and an FI group on its third. Rails 1 and 2 hold the WAGO
 * terminals, so the LS row moves to the first empty rail below — after the
 * FI, which would then feed it.
 */
const regroupBoard = (): PanelDocument =>
  board(
    [
      row("v1", [dev("mcb", { id: "a1", designation: "F0.1", circuit: "1" })], "F2 · Verteiler 1"),
      row("v3", [dev("rcd", { id: "f1", designation: "F1" }), dev("mcb", { id: "b1", designation: "F1.1", circuit: "2" })], "F2 · Verteiler 3"),
    ],
    { code: "ZB33S", modules: [mod("m2", "ZU37KS", 1, { r1: "v1", r3: "v3" })] },
  );

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(updatePanel).mockReset();
  vi.mocked(updatePanel).mockResolvedValue(PLAN);
  onError.mockReset();
  onNotice.mockReset();
  latest.document = null;
  latest.actions = new Map();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useAufbauTerminalActions", () => {
  it("keys every suggestion of the board by rule and row, labelled as on the Schrank tab", () => {
    render(<Host initial={boardDocument("terminals_zb34s")} index={FIXTURE_INDEX} />);
    expect([...latest.actions.keys()].sort()).toEqual([
      "encl.terminal_placeholders|row-old2",
      "encl.terminal_rail_devices|row-old1",
      "encl.terminal_rail_devices|row-old2",
    ]);
    expect(latest.actions.get("encl.terminal_rail_devices|row-old1")?.label).toBe("Vorschlag ausführen");
    // One vacate for both rows: either row's button runs the same suggestion.
    expect(latest.actions.get("encl.terminal_rail_devices|row-old2")).toBe(latest.actions.get("encl.terminal_rail_devices|row-old1"));
    expect(latest.actions.get("encl.terminal_placeholders|row-old2")?.label).toBe("Platzhalter entfernen");
    expect(note()).toBeNull();
  });

  it("moves both rows in one edit, says so, and Rückgängig restores the exact prior board", () => {
    const initial = boardDocument("terminals_zb34s");
    render(<Host initial={initial} index={FIXTURE_INDEX} />);
    const before = current();
    run("encl.terminal_rail_devices|row-old2");

    expect(railsOf(current(), "mod-rk")).toEqual({ r3: "row-old1", r4: "row-old2" });
    expect(railsOf(current(), "mod-k")).toEqual({ r3: "row-k3", r4: "row-k4", r5: "row-k5", r6: "row-k6", r7: "row-k7" });
    expect(note()).toHaveTextContent("Vorschlag ausgeführt: Reihen auf F3 · Verteiler 3 und F3 · Verteiler 4 umgehängt.");
    expect(onError).not.toHaveBeenCalled();
    // The vacated board has nothing left to suggest on F2's top rails.
    expect(latest.actions.has("encl.terminal_rail_devices|row-old1")).toBe(false);

    fireEvent.click(within(note() as HTMLElement).getByRole("button", { name: "Rückgängig" }));
    expect(current()).toBe(before);
    expect(note()).toHaveTextContent("Verschieben rückgängig gemacht.");
  });

  it("waits for RegroupConfirm when the move would change a feed; „Abbrechen“ changes nothing", () => {
    render(<Host initial={regroupBoard()} index={INDEX} />);
    const before = current();
    run("encl.terminal_rail_devices|v1");

    const confirm = screen.getByRole("alertdialog", { name: "Stromkreise ändern ihre Einspeisung" });
    expect(within(confirm).getByText("F0.1: Einspeisung → F1")).toBeInTheDocument();
    expect(current()).toBe(before);
    fireEvent.click(within(confirm).getByRole("button", { name: "Abbrechen" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(window.document.querySelector(".sp-sheet-backdrop")).toBeNull();
    expect(current()).toBe(before);
    expect(note()).toBeNull();
  });

  it("applies after „Trotzdem ausführen“, then offers Rückgängig", () => {
    render(<Host initial={regroupBoard()} index={INDEX} />);
    const before = current();
    run("encl.terminal_rail_devices|v1");
    fireEvent.click(screen.getByRole("button", { name: "Trotzdem ausführen" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(railsOf(current(), "m2")).toEqual({ r3: "v3", r4: "v1" });
    expect(feedMap(current()).get("a1")).toBe("f1");
    expect(note()).toHaveTextContent("Vorschlag ausgeführt: Reihe auf F2 · Verteiler 4 umgehängt.");
    fireEvent.click(within(note() as HTMLElement).getByRole("button", { name: "Rückgängig" }));
    expect(current()).toBe(before);
  });

  it("offers nothing on a read-only board", () => {
    render(<Host initial={boardDocument("terminals_zb34s")} index={FIXTURE_INDEX} readOnly />);
    expect(latest.actions.size).toBe(0);
  });

  it("offers nothing before the cabinet catalogue is there", () => {
    render(<Host initial={boardDocument("terminals_zb34s")} index={FIXTURE_INDEX} catalogLoaded={false} />);
    expect(latest.actions.size).toBe(0);
  });
});
