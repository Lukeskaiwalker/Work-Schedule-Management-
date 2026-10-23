/**
 * One derivation of a board's WAGO terminals per document
 * (docs/PANEL_ENCLOSURE_R2.md §3.1, §6.7, slice W4b): SchaltplanPage calls
 * `useBoardTerminals` once and hands the same answer to the Schrank tab,
 * the Klemmen tab and the label sheet, so all three number alike and none
 * derives a cabinet board without its skip set. The three views are stubbed
 * here to see exactly what the page passes; their own behaviour is tested
 * in their own files. The board is the shared fixture's `terminals_zb34s`,
 * invented data — the repo is public.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AppContext } from "../context/AppContext";
import { SchaltplanPage } from "../pages/SchaltplanPage";
import { resetEnclosureCatalogCache } from "../hooks/useEnclosureCatalog";
import type { BoardTerminalsState } from "../hooks/useBoardTerminals";
import type { PanelDocument, PanelPlan, PanelPlanSummary } from "../types/schaltplan";
import { makeAppContextStub } from "./appContextStub";
import { boardDocument, FIXTURE_CATALOG } from "./enclosureFixtureBoards";

/** What each stubbed view was handed, render by render. */
const seen = vi.hoisted(() => ({
  enclosure: [] as (BoardTerminalsState | undefined)[],
  list: [] as (BoardTerminalsState | undefined)[],
  dialog: [] as (BoardTerminalsState | undefined)[],
}));

vi.mock("../components/schaltplan/enclosure/EnclosureTab", () => ({
  EnclosureTab: (props: { boardTerminals?: BoardTerminalsState }) => {
    seen.enclosure.push(props.boardTerminals);
    return <p>Schrank-Stub</p>;
  },
}));

vi.mock("../components/schaltplan/TerminalList", () => ({
  TerminalList: (props: { boardTerminals?: BoardTerminalsState }) => {
    seen.list.push(props.boardTerminals);
    return <p>Klemmen-Stub</p>;
  },
}));

vi.mock("../components/schaltplan/LabelPrintDialog", () => ({
  LabelPrintDialog: (props: { boardTerminals?: BoardTerminalsState }) => {
    seen.dialog.push(props.boardTerminals);
    return null;
  },
}));

vi.mock("../utils/schaltplanApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/schaltplanApi")>();
  return { ...actual, listPanels: vi.fn(), listRecentPanels: vi.fn(), getPanel: vi.fn(), updatePanel: vi.fn() };
});

vi.mock("../utils/schaltplanEnclosureApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/schaltplanEnclosureApi")>();
  return { ...actual, getEnclosureCatalog: vi.fn() };
});

import { getPanel, listPanels, listRecentPanels, updatePanel } from "../utils/schaltplanApi";
import { getEnclosureCatalog } from "../utils/schaltplanEnclosureApi";

const SUMMARY: PanelPlanSummary = {
  id: 7,
  panel_number: "VT-0007",
  customer_id: 3,
  customer_name: "Schulze",
  project_id: null,
  project_number: null,
  project_name: null,
  name: "Unterverteiler Keller",
  designation: "UV1",
  panel_type: "sub",
  location: null,
  fed_from_panel_id: null,
  fed_from_designation: null,
  status: "draft",
  revision: 3,
  device_count: 0,
  circuit_count: 0,
  rcd_count: 0,
  used_slots: 0,
  total_slots: 12,
  row_count: 1,
  updated_at: "2026-10-21T08:00:00",
  updated_by_name: "Test",
};

const PLAIN_BOARD: PanelDocument = {
  version: 1,
  supply: { system: "TN-S", voltage: "400/230 V", incoming: "", fuse: "", meter_number: "", note: "" },
  rows: [{ id: "r1", label: "Reihe 1", slots: 12, devices: [] }],
};

const plan = (document: PanelDocument): PanelPlan => ({
  ...SUMMARY,
  document,
  notes: null,
  legend: [],
  findings: [],
  terminal_bom: [],
  created_at: "2026-10-01T08:00:00",
  created_by_name: "Test",
});

const last = <T,>(entries: readonly T[]): T | undefined => entries[entries.length - 1];

async function openBoard(document: PanelDocument) {
  vi.mocked(getPanel).mockResolvedValue(plan(document));
  render(
    <AppContext.Provider
      value={
        makeAppContextStub({
          overrides: { user: { id: 1, email: "test@example.com", role: "employee", effective_permissions: ["reports:create"] } },
        }) as never
      }
    >
      <SchaltplanPage />
    </AppContext.Provider>,
  );
  fireEvent.focus(await screen.findByPlaceholderText("Kunde suchen…"));
  fireEvent.mouseDown(await screen.findByText("VT-0007 · UV1 Unterverteiler Keller"));
  await screen.findByRole("heading", { name: "Unterverteiler Keller" });
}

beforeEach(() => {
  seen.enclosure.length = 0;
  seen.list.length = 0;
  seen.dialog.length = 0;
  resetEnclosureCatalogCache();
  vi.mocked(updatePanel).mockReset();
  vi.mocked(updatePanel).mockImplementation(async (_token, _id, patch) => plan(patch.document as PanelDocument));
  vi.mocked(getEnclosureCatalog).mockReset();
  vi.mocked(getEnclosureCatalog).mockResolvedValue(FIXTURE_CATALOG);
  vi.mocked(listPanels).mockResolvedValue([]);
  vi.mocked(listRecentPanels).mockResolvedValue([SUMMARY]);
});

describe("SchaltplanPage — one useBoardTerminals for every view", () => {
  it("hands the same answer to the Schrank tab, the label sheet and the Klemmen tab", async () => {
    await openBoard(boardDocument("terminals_zb34s"));
    await waitFor(() => expect(last(seen.enclosure)?.ready).toBe(true));
    const state = last(seen.enclosure)!;
    // Derived with the cabinet's skip set: the AAR circuit gets no terminal.
    expect(state.terms?.skip.has("dev-aar-ls1")).toBe(true);
    expect(state.placement?.fields.map((field) => field.field)).toEqual([1, 2, 3]);
    expect(last(seen.dialog)).toBe(state);

    fireEvent.click(screen.getByRole("tab", { name: /^Klemmen/ }));
    await screen.findByText("Klemmen-Stub");
    expect(last(seen.list)).toBe(state);
    expect(last(seen.dialog)).toBe(state);
  });

  it("tells the Schrank tab and the label sheet to wait while a cabinet board's catalogue loads", async () => {
    vi.mocked(getEnclosureCatalog).mockReturnValue(new Promise(() => undefined));
    await openBoard(boardDocument("terminals_zb34s"));
    await screen.findByText("Schrank-Stub");
    expect(last(seen.enclosure)).toEqual({ ready: false, terms: null, placement: null });
    expect(last(seen.dialog)).toEqual({ ready: false, terms: null, placement: null });
  });

  it("is ready at once on a board without a cabinet, without fetching the catalogue", async () => {
    await openBoard(PLAIN_BOARD);
    fireEvent.click(screen.getByRole("tab", { name: /^Klemmen/ }));
    await screen.findByText("Klemmen-Stub");
    expect(last(seen.list)?.ready).toBe(true);
    expect(last(seen.list)?.terms?.skip.size).toBe(0);
    expect(getEnclosureCatalog).not.toHaveBeenCalled();
  });
});
