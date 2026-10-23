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
import { pinnedToast } from "../components/schaltplan/enclosure/RegroupConfirm";
import { makeDevice } from "../utils/schaltplanDevices";
import type { EnclosureModule } from "../types/panelEnclosure";
import type { PanelDocument, PanelMaterial, PanelPlan, PanelPlanSummary } from "../types/schaltplan";
import { makeAppContextStub } from "./appContextStub";
import { aufbauCatalog, ownerBoard } from "./enclosureAufbauBoards";
import { boardDocument, FIXTURE_CATALOG } from "./enclosureFixtureBoards";
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

function renderPage(overrides: Record<string, unknown> = {}) {
  render(
    <AppContext.Provider
      value={
        makeAppContextStub({
          overrides: {
            user: { id: 1, email: "test@example.com", role: "employee", effective_permissions: ["reports:create"] },
            ...overrides,
          },
        }) as never
      }
    >
      <SchaltplanPage />
    </AppContext.Provider>,
  );
}

async function openBoard(document: PanelDocument, overrides: Record<string, unknown> = {}) {
  vi.mocked(getPanel).mockResolvedValue(plan(document));
  renderPage(overrides);
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

    // A breaker on the Verteilerfeld's first rail below its two terminal rails (R2), from the drawing.
    fireEvent.click(screen.getByRole("button", { name: /^Hutschiene F2 · Verteiler 3 · leer/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "F2 · Verteiler 3" })).getByRole("button", { name: "+ Gerät" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Gerät hinzufügen" })).getByRole("button", { name: /^Leitungsschutzschalter/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Leitungsschutzschalter" })).getByRole("button", { name: "Schließen" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "F2 · Verteiler 3" })).getByRole("button", { name: "Schließen" }));

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

describe("SchaltplanPage — Aufbau lists every rail (docs/PANEL_ENCLOSURE_R2.md §9)", () => {
  const VT_REGION = "Feld 3 · ZU37VT5APZ2 Modul ZU37VT5APZ2";
  const savedRow = (document: PanelDocument, moduleId: string, railKey: string) => {
    const rowId = document.enclosure?.modules.find((module) => module.id === moduleId)?.rails[railKey];
    return document.rows.find((candidate) => candidate.id === rowId);
  };
  const addOnRail = (title: string, kind: RegExp) => {
    fireEvent.click(screen.getByRole("button", { name: `Gerät auf ${title} hinzufügen` }));
    const palette = screen.getByRole("dialog", { name: "Gerät hinzufügen" });
    expect(within(palette).getByText(title)).toBeInTheDocument();
    fireEvent.click(within(palette).getByRole("button", { name: kind }));
  };
  /**
   * A ZB33S with only a ZU37KS in field 2, one LS on its fourth rail —
   * straight off the Einspeisung. Rails 1 and 2 hold the WAGO terminals (R2).
   */
  const fedByEinspeisung = (): PanelDocument => ({
    ...CABINET_BOARD,
    rows: [{ id: "v4", label: "F2 · Verteiler 4", slots: 12, devices: [makeDevice("mcb", { id: "b1", designation: "F1.1", circuit: "1" })] }],
    enclosure: { code: "ZB33S", modules: [mod("m2", "ZU37KS", 1, { r4: "v4" })] },
  });

  it("puts the first device on the owner's empty ZU37VT5APZ2 and opens its inspector", async () => {
    vi.mocked(getEnclosureCatalog).mockResolvedValue(aufbauCatalog());
    await openBoard(ownerBoard());
    fireEvent.click(screen.getByRole("tab", { name: "Aufbau" }));
    const field = await screen.findByRole("region", { name: VT_REGION });
    // Rails 1 and 2 hold the WAGO terminals: four rails take a device.
    expect(within(field).getAllByRole("button", { name: /^Gerät auf F3 · / })).toHaveLength(4);

    addOnRail("F3 · Verteiler 3", /^Leitungsschutzschalter/);

    expect(screen.queryByRole("dialog", { name: "Gerät hinzufügen" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Leitungsschutzschalter" })).toBeInTheDocument();
    const after = screen.getByRole("region", { name: VT_REGION });
    expect(within(after).getByDisplayValue("F3 · Verteiler 3")).toBeInTheDocument();
    expect(within(after).getAllByRole("button", { name: /^Gerät auf F3 · / })).toHaveLength(3);

    await waitFor(() => expect(updatePanel).toHaveBeenCalled(), { timeout: 3000 });
    const added = savedRow(lastSaved(), "m-vt", "r3");
    expect(added).toEqual(expect.objectContaining({ label: "F3 · Verteiler 3", slots: 12 }));
    expect(added?.devices.map((device) => device.kind)).toEqual(["mcb"]);
  });

  it("keeps the SLS → HS link when the SLS goes onto the meter field's empty NAR", async () => {
    await openBoard(CABINET_BOARD);
    fireEvent.click(screen.getByRole("tab", { name: "Aufbau" }));
    await screen.findByRole("region", { name: /^Feld 1 · ZH3EH16/ });

    addOnRail("F1 · NAR", /^SLS-Schalter/);

    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(updatePanel).toHaveBeenCalled(), { timeout: 3000 });
    const saved = lastSaved();
    const sls = savedRow(saved, "m1", "nar")?.devices[0];
    expect(sls?.kind).toBe("sls");
    const hs = saved.rows.flatMap((candidate) => candidate.devices).find((device) => device.id === "hs1");
    expect(hs?.parent_id).toBe(sls?.id);
  });

  it("keeps a circuit's feed with the pinned toast, as on the Schrank tab", async () => {
    const setNotice = vi.fn();
    const withCircuit: PanelDocument = {
      ...CABINET_BOARD,
      rows: [...CABINET_BOARD.rows, { id: "v4", label: "F2 · Verteiler 4", slots: 12, devices: [makeDevice("mcb", { id: "b1", designation: "F1.1", circuit: "1" })] }],
      enclosure: { ...CABINET_BOARD.enclosure!, modules: [CABINET_BOARD.enclosure!.modules[0], mod("m2", "ZU37KS", 1, { r4: "v4" })] },
    };
    await openBoard(withCircuit, { setNotice });
    fireEvent.click(screen.getByRole("tab", { name: "Aufbau" }));
    await screen.findByRole("region", { name: /^Feld 2 · ZU37KS/ });

    addOnRail("F2 · Verteiler 3", /^FI-Schutzschalter \(RCD\)/);

    expect(setNotice).toHaveBeenCalledWith(pinnedToast(1));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("dialog", { name: "FI-Schutzschalter (RCD)" })).toBeInTheDocument();
  });

  it("asks before a circuit changes its feed, and adds nothing on „Abbrechen“", async () => {
    await openBoard(fedByEinspeisung());
    fireEvent.click(screen.getByRole("tab", { name: "Aufbau" }));
    await screen.findByRole("region", { name: /^Feld 2 · ZU37KS/ });

    addOnRail("F2 · Verteiler 3", /^FI-Schutzschalter \(RCD\)/);
    const confirm = screen.getByRole("alertdialog", { name: "Stromkreise ändern ihre Einspeisung" });
    expect(within(confirm).getByText("F1.1: Einspeisung → FI")).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole("button", { name: "Abbrechen" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "FI-Schutzschalter (RCD)" })).toBeNull();
    expect(screen.getByRole("button", { name: "Gerät auf F2 · Verteiler 3 hinzufügen" })).toBeInTheDocument();
  });

  it("adds the device after „Trotzdem ausführen“ and opens its inspector", async () => {
    await openBoard(fedByEinspeisung());
    fireEvent.click(screen.getByRole("tab", { name: "Aufbau" }));
    await screen.findByRole("region", { name: /^Feld 2 · ZU37KS/ });

    addOnRail("F2 · Verteiler 3", /^FI-Schutzschalter \(RCD\)/);
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Trotzdem ausführen" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("dialog", { name: "FI-Schutzschalter (RCD)" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Gerät auf F2 · Verteiler 3 hinzufügen" })).toBeNull();
  });

  it("still adds to an existing row as a plain edit and opens the new device", async () => {
    await openBoard(CABINET_BOARD);
    fireEvent.click(screen.getByRole("tab", { name: "Aufbau" }));
    const field = await screen.findByRole("region", { name: /^Feld 1 · ZH3EH16/ });
    fireEvent.click(within(field).getByRole("button", { name: /^\+ ?Gerät$/ }));
    const palette = screen.getByRole("dialog", { name: "Gerät hinzufügen" });
    expect(within(palette).getByText("F1 · AAR 1")).toBeInTheDocument();
    fireEvent.click(within(palette).getByRole("button", { name: /^Leitungsschutzschalter/ }));

    expect(screen.getByRole("dialog", { name: "Leitungsschutzschalter" })).toBeInTheDocument();
    await waitFor(() => expect(updatePanel).toHaveBeenCalled(), { timeout: 3000 });
    expect(savedRow(lastSaved(), "m1", "aar1")?.devices.map((device) => device.kind)).toEqual(["hauptschalter", "mcb"]);
  });

  it("offers „Erneut laden“ on Aufbau when the cabinet catalogue failed, above the flat list", async () => {
    vi.mocked(getEnclosureCatalog).mockRejectedValueOnce(new Error("Netzwerkfehler"));
    await openBoard(CABINET_BOARD);
    fireEvent.click(screen.getByRole("tab", { name: "Aufbau" }));
    const alert = await screen.findByText("Schrankkatalog konnte nicht geladen werden.");
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.getByDisplayValue("F1 · AAR 1")).toBeInTheDocument();

    fireEvent.click(within(alert.closest("[role=alert]") as HTMLElement).getByRole("button", { name: "Erneut laden" }));
    expect(await screen.findByRole("region", { name: /^Feld 1 · ZH3EH16/ })).toBeInTheDocument();
    expect(screen.queryByText("Schrankkatalog konnte nicht geladen werden.")).toBeNull();
  });
});

/**
 * Round 2, slice W4b (docs/PANEL_ENCLOSURE_R2.md §3.1, §6.7, §9): the page
 * derives the board's terminals once, with the cabinet's skip set, and every
 * view numbers alike — Klemmen tab, legend, inspector, bulk switch, Aufbau.
 * The board is the shared fixture's `terminals_zb34s` (an LS with
 * „Reihenklemme“ in the AAR, rows on F2's terminal rails, an empty RK field).
 */
describe("SchaltplanPage — WAGO terminals on a cabinet board", () => {
  const terminalsBoard = () => boardDocument("terminals_zb34s");
  const savedDevice = (id: string) => lastSaved().rows.flatMap((candidate) => candidate.devices).find((device) => device.id === id);
  const legendRow = (designation: string) =>
    screen.getAllByRole("row").find((candidate) => within(candidate).queryAllByRole("cell")[1]?.textContent === designation) as HTMLElement;

  beforeEach(() => {
    vi.mocked(getEnclosureCatalog).mockResolvedValue(FIXTURE_CATALOG);
  });

  it("numbers the Klemmen tab without the AAR circuit and lists the end plates", async () => {
    await openBoard(terminalsBoard());
    fireEvent.click(screen.getByRole("tab", { name: /^Klemmen/ }));
    expect(await screen.findByText(/Klemmenleisten \(X1–X12\) · .* · 90 von 90 Abgängen$/)).toBeInTheDocument();
    const bom = screen.getByRole("region", { name: "Stückliste Reihenklemmen" });
    expect(within(bom).getByText("WAGO 2003-7692")).toBeInTheDocument();
    expect(within(bom).getByText("WAGO 2016-7691")).toBeInTheDocument();

    // The label sheet lists the same twelve strips.
    fireEvent.click(screen.getByRole("button", { name: "Klemmen-Etiketten drucken" }));
    const sheet = screen.getByRole("dialog", { name: "Klemmen-Etiketten drucken" });
    expect(within(within(sheet).getByRole("list", { name: "Klemmenleisten" })).getAllByRole("checkbox")).toHaveLength(12);
  });

  it("gives the AAR circuit no X label in the legend, and the Verteilerfeld's circuits theirs", async () => {
    await openBoard(terminalsBoard());
    fireEvent.click(screen.getByRole("tab", { name: /^Legende/ }));
    const terminalsCell = (designation: string) => {
      const cells = within(legendRow(designation)).getAllByRole("cell");
      return cells[cells.length - 1];
    };
    expect(terminalsCell("F0.1")).toHaveTextContent(/^—$/);
    expect(terminalsCell("F1.1")).toHaveTextContent(/^X1\./);
  });

  it("says in the inspector that the AAR gets no terminal, and keeps the checkbox in the Verteilerfeld", async () => {
    await openBoard(terminalsBoard());
    fireEvent.click(screen.getByRole("tab", { name: "Aufbau" }));
    await screen.findByRole("region", { name: /^Feld 1 · ZH3EH16/ });
    fireEvent.click(screen.getByTitle("Leitungsschutzschalter — Steuerung SMGW"));
    expect(screen.getByText("Im AAR keine Reihenklemme — nur in Verteilerfeldern.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Reihenklemme am Abgang (WAGO)")).toBeNull();

    fireEvent.click(screen.getByTitle("Leitungsschutzschalter — Stromkreis 2"));
    expect(screen.getByLabelText("Reihenklemme am Abgang (WAGO)")).toBeChecked();
    expect(screen.queryByText(/keine Reihenklemme — nur in Verteilerfeldern/)).toBeNull();
  });

  it("checks device names against the strips the board really gets (X1–X12, not X13)", async () => {
    const renamed: Record<string, string> = { "dev-x0": "X13", "dev-q0": "X12" };
    const board = terminalsBoard();
    await openBoard({
      ...board,
      rows: board.rows.map((candidate) => ({
        ...candidate,
        devices: candidate.devices.map((device) => (renamed[device.id] ? { ...device, designation: renamed[device.id] } : device)),
      })),
    });
    fireEvent.click(screen.getByRole("tab", { name: /^Klemmen/ }));
    await screen.findByText(/Klemmenleisten \(X1–X12\)/);
    const banner = screen.getByText("Prüfen:").closest("[role=status]") as HTMLElement;
    expect(within(banner).getByText("X12: so heißt auch eine Klemmleiste — Gerät umbenennen (zwei Teile mit einem BMK).")).toBeInTheDocument();
    // Only without the skip set would the AAR circuit make a 13th strip.
    expect(within(banner).queryByText(/^X13: /)).toBeNull();
  });

  it("leaves the AAR circuit alone when „Alle ohne“ clears the board", async () => {
    await openBoard(terminalsBoard());
    fireEvent.click(screen.getByRole("tab", { name: /^Klemmen/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Alle ohne" }));
    await waitFor(() => expect(updatePanel).toHaveBeenCalled(), { timeout: 3000 });
    expect(savedDevice("dev-f1-1")?.terminal_block).toBe(false);
    expect(savedDevice("dev-aar-ls1")?.terminal_block).toBe(true);
  });

  it("waits on the Klemmen tab while the cabinet catalogue loads", async () => {
    vi.mocked(getEnclosureCatalog).mockReturnValue(new Promise(() => undefined));
    await openBoard(terminalsBoard());
    fireEvent.click(screen.getByRole("tab", { name: /^Klemmen/ }));
    expect(screen.getByRole("tab", { name: /^Klemmen/ })).toHaveTextContent(/^Klemmen$/);
    expect(screen.getByText("Schrankkatalog wird geladen…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Klemmen-Etiketten drucken" })).toBeNull();
    expect(screen.queryByText(/Klemmenleisten \(X1/)).toBeNull();
  });

  it("says so on the Klemmen tab when the cabinet catalogue failed, and numbers after „Erneut laden“", async () => {
    vi.mocked(getEnclosureCatalog).mockRejectedValueOnce(new Error("Netzwerkfehler"));
    await openBoard(terminalsBoard());
    fireEvent.click(screen.getByRole("tab", { name: /^Klemmen/ }));
    const alert = (await screen.findByText("Schrankkatalog konnte nicht geladen werden.")).closest("[role=alert]") as HTMLElement;
    // Never "wird geladen…" for a fetch that is over.
    expect(screen.queryByText("Schrankkatalog wird geladen…")).toBeNull();
    expect(screen.queryByText(/Klemmenleisten \(X1/)).toBeNull();

    fireEvent.click(within(alert).getByRole("button", { name: "Erneut laden" }));
    expect(await screen.findByText(/Klemmenleisten \(X1–X12\)/)).toBeInTheDocument();
    expect(screen.queryByText("Schrankkatalog konnte nicht geladen werden.")).toBeNull();
  });

  const VACATE_SENTENCE = " Vorschlag: Reihen auf F3 · Verteiler 3 und F3 · Verteiler 4 umhängen.";
  const oldRow = (label: string) => screen.getByDisplayValue(label).closest("section") as HTMLElement;
  const railsOf = (document: PanelDocument, moduleId: string) => document.enclosure?.modules.find((module) => module.id === moduleId)?.rails;
  const dropNote = () => window.document.querySelector(".sp-encl-dropnote") as HTMLElement | null;

  it("marks the terminal rails on the Aufbau tab: the finding on the old rows, strips on the empty ones", async () => {
    await openBoard(terminalsBoard());
    fireEvent.click(screen.getByRole("tab", { name: "Aufbau" }));
    await screen.findByRole("region", { name: /^Feld 2 · ZU37KS/ });
    const old = oldRow("F2 · Verteiler 1");
    expect(within(old).getByRole("note")).toHaveTextContent(
      `F2 · Verteiler 1: Hutschiene ist für Reihenklemmen reserviert — 5 Gerät(e) tiefer setzen.${VACATE_SENTENCE}`,
    );
    expect(within(old).getByRole("button", { name: "Vorschlag ausführen" })).toBeInTheDocument();
    expect(within(old).queryByRole("button", { name: /^\+ ?Gerät$/ })).toBeNull();
    expect(within(oldRow("F2 · Verteiler 2")).getByRole("note")).toHaveTextContent(
      `F2 · Verteiler 2: Hutschiene ist für Reihenklemmen reserviert — 3 Gerät(e) tiefer setzen.${VACATE_SENTENCE}`,
    );
    expect(screen.getAllByText("für Reihenklemmen reserviert · noch keine")).toHaveLength(2);
    expect(screen.getByText("für Reihenklemmen reserviert · X7, X8, X10")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gerät auf F3 · Verteiler 3 hinzufügen" })).toBeInTheDocument();
  });

  it("runs the vacate from the Aufbau banner: both rows move in one edit, and Rückgängig puts them back", async () => {
    const original = terminalsBoard();
    await openBoard(original);
    fireEvent.click(screen.getByRole("tab", { name: "Aufbau" }));
    await screen.findByRole("region", { name: /^Feld 2 · ZU37KS/ });

    fireEvent.click(within(oldRow("F2 · Verteiler 1")).getByRole("button", { name: "Vorschlag ausführen" }));

    expect(dropNote()).toHaveTextContent("Vorschlag ausgeführt: Reihen auf F3 · Verteiler 3 und F3 · Verteiler 4 umgehängt.");
    await waitFor(() => expect(updatePanel).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const moved = lastSaved();
    expect(railsOf(moved, "mod-rk")).toEqual({ r3: "row-old1", r4: "row-old2" });
    expect(railsOf(moved, "mod-k")).not.toHaveProperty("r1");
    expect(railsOf(moved, "mod-k")).not.toHaveProperty("r2");
    // Nothing is reserved any more on F2's top rails, and the banner went with the rows.
    expect(screen.queryByRole("button", { name: "Vorschlag ausführen" })).toBeNull();

    fireEvent.click(within(dropNote() as HTMLElement).getByRole("button", { name: "Rückgängig" }));
    await waitFor(() => expect(updatePanel).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(lastSaved()).toEqual(original);
    expect(within(oldRow("F2 · Verteiler 1")).getByRole("button", { name: "Vorschlag ausführen" })).toBeInTheDocument();
  });

  it("offers no „Vorschlag ausführen“ on a board the viewer may not edit", async () => {
    await openBoard(terminalsBoard(), { user: { id: 2, email: "viewer@example.com", role: "employee", effective_permissions: [] } });
    fireEvent.click(screen.getByRole("tab", { name: "Aufbau" }));
    await screen.findByRole("region", { name: /^Feld 2 · ZU37KS/ });
    expect(within(oldRow("F2 · Verteiler 1")).getByRole("note")).toHaveTextContent(VACATE_SENTENCE.trim());
    expect(screen.queryByRole("button", { name: "Vorschlag ausführen" })).toBeNull();
  });
});
