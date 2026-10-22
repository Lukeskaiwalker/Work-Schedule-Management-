/**
 * The cabinet on the Verteilerplan page, end to end (docs/PANEL_ENCLOSURE.md
 * §11, §14): the Schrank tab sits between Plan and Aufbau, a board with a
 * cabinet opens on it, the "Prüfen:" banner sums the cabinet's warnings in
 * one chip, a new board can start with a cabinet — and the fitter's whole
 * round: plan a ZB33S with a meter field and a Verteilerfeld, put a breaker
 * on a rail, take the pre-fitted Hauptschalter out, and find it on the
 * Materialliste as a part that goes back on the shelf.
 *
 * The API is mocked; the catalogue is the small invented test catalogue.
 * All data is invented — the repo is public.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { AppContext } from "../context/AppContext";
import { SchaltplanPage } from "../pages/SchaltplanPage";
import { resetEnclosureCatalogCache } from "../hooks/useEnclosureCatalog";
import { makeDevice } from "../utils/schaltplanDevices";
import type { EnclosureModule } from "../types/panelEnclosure";
import type { PanelDocument, PanelMaterial, PanelPlan, PanelPlanSummary } from "../types/schaltplan";
import { makeAppContextStub } from "./appContextStub";
import { testCatalog } from "./enclosureTestCatalog";

vi.mock("../utils/schaltplanApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/schaltplanApi")>();
  return {
    ...actual,
    listPanels: vi.fn(),
    listRecentPanels: vi.fn(),
    getPanel: vi.fn(),
    createPanel: vi.fn(),
    updatePanel: vi.fn(),
    getPanelMaterial: vi.fn(),
  };
});

vi.mock("../utils/schaltplanEnclosureApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/schaltplanEnclosureApi")>();
  return { ...actual, getEnclosureCatalog: vi.fn() };
});

import { createPanel, getPanel, getPanelMaterial, listPanels, listRecentPanels, updatePanel } from "../utils/schaltplanApi";
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

const SUPPLY = { system: "TN-S" as const, voltage: "400/230 V", incoming: "", fuse: "", meter_number: "", note: "" };

const PLAIN_BOARD: PanelDocument = { version: 1, supply: SUPPLY, rows: [{ id: "r1", label: "Reihe 1", slots: 12, devices: [] }] };

const mod = (id: string, code: string, field: number, rails: Record<string, string> = {}, extra: Partial<EnclosureModule> = {}): EnclosureModule => ({
  id, code, field, unit: 0, label: "", rails, fittings: null, removed_fittings: [], meters: [], ...extra,
});

/** A ZB33S with a meter field (pre-fitted HS on AAR 1, meter numbered) and an empty Verteilerfeld. */
const CABINET_BOARD: PanelDocument = {
  version: 1,
  supply: SUPPLY,
  rows: [{ id: "aar1", label: "F1 · AAR 1", slots: 12, devices: [makeDevice("hauptschalter", { id: "hs1", designation: "Q1", supplied_by: { module: "m1", part: "hs" } })] }],
  terminal_labels: {},
  enclosure: {
    code: "ZB33S",
    modules: [mod("m1", "ZH3EH16", 0, { aar1: "aar1" }, { meters: [{ place: 0, number: "1EBZ0100000005", label: "" }] }), mod("m2", "ZU37KS", 1)],
  },
};

function plan(document: PanelDocument, overrides: Partial<PanelPlan> = {}): PanelPlan {
  return {
    ...SUMMARY,
    document,
    notes: null,
    legend: [],
    findings: [],
    terminal_bom: [],
    created_at: "2026-10-01T08:00:00",
    created_by_name: "Test",
    ...overrides,
  };
}

const MATERIAL: PanelMaterial = {
  panel: {
    id: 7,
    panel_number: "VT-0007",
    designation: "UV1",
    name: "Unterverteiler Keller",
    panel_type: "sub",
    status: "draft",
    customer_id: 3,
    customer_name: "Schulze",
    project_id: null,
    project_number: null,
    project_name: null,
    updated_at: "2026-10-21T08:00:00",
  },
  lines: [
    {
      key: "removed:ZH3EH16:hs",
      kind: "removed",
      label: "Hauptschalter",
      detail: "aus Modul entfernt → ins Lager · ZH3EH16",
      planned: 1,
      scanned: 0,
      status: "open",
      article: { id: 612, article_number: "SP-0612", item_name: "Hager Hauptschalter 3-polig", manufacturer: "Hager", unit: "ST", internal_code: null, stock_available: 0 },
      article_source: "auto",
      last_scanned_at: null,
    },
  ],
  planned_total: 0,
  scanned_total: 0,
  open_lines: 0,
  returns_open: 1,
  last_scanned_at: null,
};

function renderPage() {
  render(
    <AppContext.Provider
      value={
        makeAppContextStub({
          overrides: {
            user: { id: 1, email: "test@example.com", role: "employee", effective_permissions: ["reports:create"] },
          },
        }) as never
      }
    >
      <SchaltplanPage />
    </AppContext.Provider>,
  );
}

async function openBoard(document: PanelDocument) {
  vi.mocked(getPanel).mockResolvedValue(plan(document));
  renderPage();
  fireEvent.focus(await screen.findByPlaceholderText("Kunde suchen…"));
  fireEvent.mouseDown(await screen.findByText("VT-0007 · UV1 Unterverteiler Keller"));
  await screen.findByRole("heading", { name: "Unterverteiler Keller" });
}

const tabNames = () => screen.getAllByRole("tab").map((tab) => (tab.textContent ?? "").replace(/\d+$/, ""));
const selectedTab = () => screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent;
const lastSaved = () => {
  const calls = vi.mocked(updatePanel).mock.calls;
  return calls[calls.length - 1][2].document as PanelDocument;
};

beforeEach(() => {
  resetEnclosureCatalogCache();
  vi.mocked(updatePanel).mockReset();
  vi.mocked(updatePanel).mockImplementation(async (_token, _id, patch) => plan(patch.document as PanelDocument));
  vi.mocked(getPanelMaterial).mockReset();
  vi.mocked(getPanelMaterial).mockResolvedValue(MATERIAL);
  vi.mocked(createPanel).mockReset();
  vi.mocked(getEnclosureCatalog).mockReset();
  vi.mocked(getEnclosureCatalog).mockResolvedValue(testCatalog());
  vi.mocked(listPanels).mockResolvedValue([]);
  vi.mocked(listRecentPanels).mockResolvedValue([SUMMARY]);
});

describe("SchaltplanPage — Schrank tab", () => {
  it("sits between Plan and Aufbau, and a board without a cabinet opens on Plan", async () => {
    await openBoard(PLAIN_BOARD);
    expect(tabNames()).toEqual(["Plan", "Schrank", "Aufbau", "Klemmen", "Material", "Legende", "Daten"]);
    expect(selectedTab()).toBe("Plan");
    // Nothing on this board needs the cabinet catalogue yet.
    expect(getEnclosureCatalog).not.toHaveBeenCalled();
  });

  it("opens a board with a cabinet on Schrank", async () => {
    await openBoard(CABINET_BOARD);
    expect(selectedTab()).toBe("Schrank");
    expect(await screen.findByRole("navigation", { name: "Module im Schrank" })).toBeInTheDocument();
  });

  it("sums the cabinet's warnings in one chip of the Prüfen banner", async () => {
    await openBoard(CABINET_BOARD);
    const chip = await screen.findByRole("button", { name: /^Schrank: \d+ Hinweise$/ });
    const banner = chip.closest(".sp-warnings") as HTMLElement;
    expect(within(banner).queryByText(/Kein APZ im Schrank/)).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
    fireEvent.click(screen.getByRole("button", { name: /^Schrank: \d+ Hinweise$/ }));
    expect(selectedTab()).toBe("Schrank");
  });

  it("says in the Aufbau tab's inspector that a part is pre-fitted", async () => {
    await openBoard(CABINET_BOARD);
    fireEvent.click(screen.getByRole("tab", { name: "Aufbau" }));
    await screen.findByRole("region", { name: /^Feld 1 · ZH3EH16/ });
    fireEvent.click(screen.getByTitle("Hauptschalter — ohne Bezeichnung"));
    expect(screen.getByText("Vorbestückt in ZH3EH16")).toBeInTheDocument();
  });

  it("moves a device from outside the cabinet onto a rail from the Aufbau tab's inspector", async () => {
    const legacy: PanelDocument = {
      ...CABINET_BOARD,
      rows: [...CABINET_BOARD.rows, { id: "old", label: "Reihe alt", slots: 12, devices: [makeDevice("sls", { id: "q0", designation: "Q0" })] }],
    };
    await openBoard(legacy);
    fireEvent.click(screen.getByRole("tab", { name: "Aufbau" }));
    await screen.findByRole("region", { name: "Nicht im Schrank" });
    fireEvent.click(screen.getByTitle("SLS-Schalter (selektiv) — ohne Bezeichnung"));
    fireEvent.click(screen.getByRole("button", { name: "Auf andere Hutschiene…" }));

    expect(selectedTab()).toBe("Schrank");
    const picker = await screen.findByRole("dialog", { name: "Hutschiene wählen" });
    fireEvent.click(within(picker).getByRole("button", { name: /^Feld 1 · NAR · / }));
    expect(screen.queryByRole("dialog", { name: "Hutschiene wählen" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Gerät Q0 auf F1 · NAR/ })).toBeInTheDocument();
  });

  it("starts a new board with a cabinet and opens it on Schrank", async () => {
    await openBoard(PLAIN_BOARD);
    const created = plan({ version: 1, supply: SUPPLY, rows: [], enclosure: { code: "ZB33S", modules: [] } }, { id: 8, designation: "UV2" });
    vi.mocked(createPanel).mockResolvedValue(created);
    fireEvent.click(screen.getByRole("button", { name: "+ Neuer Verteiler" }));
    const dialog = screen.getByRole("dialog", { name: "Neuer Verteiler" });
    fireEvent.change(within(dialog).getByPlaceholderText("Unterverteiler Werkstatt"), { target: { value: "Unterverteiler Garage" } });
    fireEvent.change(await within(dialog).findByRole("combobox", { name: "Schrank" }), { target: { value: "ZB33S" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Verteiler anlegen" }));

    await waitFor(() => expect(createPanel).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(createPanel).mock.calls[0][1];
    expect(payload.document).toEqual(expect.objectContaining({ rows: [], enclosure: { code: "ZB33S", modules: [] } }));
    await waitFor(() => expect(selectedTab()).toBe("Schrank"));
  });
});

describe("SchaltplanPage — a cabinet from scratch to the Materialliste", () => {
  it("plans a ZB33S, fills a rail, removes the HS and lists it as a return", async () => {
    await openBoard(PLAIN_BOARD);
    fireEvent.click(screen.getByRole("tab", { name: "Schrank" }));

    // Cabinet.
    fireEvent.click(await screen.findByRole("button", { name: "Schrank wählen" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Schrank wählen" })).getByRole("button", { name: /^ZB33S · 3 Felder/ }));

    // Meter field in Feld 1, Verteilerfeld in Feld 2.
    fireEvent.click(screen.getByRole("button", { name: /^\+ Modul in Feld 1/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Modul für Feld 1" })).getByRole("button", { name: /^ZH3EH16,/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Feld 1 · ZH3EH16" })).getByRole("button", { name: "Schließen" }));
    fireEvent.click(screen.getByRole("button", { name: /^\+ Modul in Feld 2/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Modul für Feld 2" })).getByRole("button", { name: /^ZU37KS,/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Feld 2 · ZU37KS" })).getByRole("button", { name: "Schließen" }));

    // A breaker on the Verteilerfeld's first rail, from the drawing.
    fireEvent.click(screen.getByRole("button", { name: /^Hutschiene F2 · Verteiler 1 · leer/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "F2 · Verteiler 1" })).getByRole("button", { name: "+ Gerät" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Gerät hinzufügen" })).getByRole("button", { name: /^Leitungsschutzschalter/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Leitungsschutzschalter" })).getByRole("button", { name: "Schließen" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "F2 · Verteiler 1" })).getByRole("button", { name: "Schließen" }));

    // Take the pre-fitted Hauptschalter out. The new LS hung off it, so the page asks first.
    fireEvent.click(screen.getByRole("button", { name: /^Feld 1 · ZH3EH16/ }));
    fireEvent.click(screen.getByRole("button", { name: "Hauptschalter entfernen" }));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Stromkreise ändern ihre Einspeisung" })).getByRole("button", { name: "Trotzdem ausführen" }));
    const hs = within(screen.getByRole("dialog", { name: "Feld 1 · ZH3EH16" })).getByRole("listitem", { name: "Hauptschalter" });
    expect(within(hs).getByText("entfernt → ins Lager", { exact: false })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog", { name: "Feld 1 · ZH3EH16" })).getByRole("button", { name: "Schließen" }));

    // The Materialliste waits for the save, and lists the return.
    fireEvent.click(screen.getByRole("tab", { name: "Material" }));
    expect(await screen.findByText("aus Modul entfernt → ins Lager · ZH3EH16")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ins Lager" })).toBeInTheDocument();

    const saved = lastSaved();
    expect(saved.enclosure?.code).toBe("ZB33S");
    expect(saved.enclosure?.modules.map((module) => [module.code, module.field])).toEqual([["ZH3EH16", 0], ["ZU37KS", 1]]);
    const kinds = saved.rows.flatMap((candidate) => candidate.devices.map((device) => device.kind));
    expect(kinds).not.toContain("hauptschalter");
    expect(kinds).toEqual(expect.arrayContaining(["mcb", "hlak"]));
    // The meter field's place exists (number still empty), and no meter device.
    expect(saved.enclosure?.modules[0].meters).toEqual([{ place: 0, number: "", label: "" }]);
    expect(kinds).not.toContain("meter");
  });
});
