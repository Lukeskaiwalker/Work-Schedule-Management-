/**
 * The Schrank tab as one piece (docs/PANEL_ENCLOSURE.md §11, §14): the
 * empty state, the cabinet and module pickers, the field bar, the one tap
 * rule into RailSheet, the sheet stack with its single backdrop, the
 * regroup confirmation before an op applies and the pinned toast after,
 * the findings list and the lazy 3D view behind its boundary.
 *
 * Rendered with the real editor hook (the save itself is mocked), so what
 * is asserted is what the fitter would see on the tablet — every op goes
 * through `mutate`, exactly as on the page.
 *
 * Invented boards only — the repo is public.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useLayoutEffect, useMemo } from "react";

vi.mock("../utils/schaltplanApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/schaltplanApi")>();
  return { ...actual, updatePanel: vi.fn() };
});

import { EnclosureTab } from "../components/schaltplan/enclosure/EnclosureTab";
import type { Enclosure3DLoader } from "../components/schaltplan/enclosure/Enclosure3DBoundary";
import { usePanelDocumentEditor } from "../hooks/usePanelDocumentEditor";
import { catalogIndex } from "../utils/enclosureCatalog";
import { PAGE_NOT_SAVED } from "../utils/openAfterSave";
import { updatePanel } from "../utils/schaltplanApi";
import { emptyDocument } from "../utils/schaltplanDevices";
import type { EnclosureCatalog, EnclosureModule } from "../types/panelEnclosure";
import type { PanelDocument, PanelPlan } from "../types/schaltplan";
import { board, dev, row, testCatalog } from "./enclosureTestCatalog";

const PLAN = {
  id: 7,
  panel_number: "VT-0007",
  designation: "UV1",
  name: "Unterverteiler Keller",
  status: "draft",
  revision: 1,
} as unknown as PanelPlan;

const mod = (id: string, code: string, field: number, rails: Record<string, string> = {}, extra: Partial<EnclosureModule> = {}): EnclosureModule => ({
  id, code, field, unit: 0, label: "", rails, fittings: null, removed_fittings: [], meters: [], ...extra,
});

interface HostProps {
  initial: PanelDocument;
  catalog?: EnclosureCatalog;
  readOnly?: boolean;
  load3D?: Enclosure3DLoader;
  onNotice?: (message: string) => void;
  onError?: (message: string) => void;
  reloadPage?: () => void;
}

const latest: { document: PanelDocument | null } = { document: null };

function Host({ initial, catalog = testCatalog(), readOnly = false, load3D, onNotice = vi.fn(), onError = vi.fn(), reloadPage }: HostProps) {
  const editor = usePanelDocumentEditor({ token: "t", readOnly, onSaved: () => undefined, setError: onError });
  const { load } = editor;
  useLayoutEffect(() => {
    load({ panelId: PLAN.id, document: initial });
  }, [load, initial]);
  const state = useMemo(
    () => ({ catalog, index: catalogIndex(catalog), loading: false, error: null, reload: async () => undefined }),
    [catalog],
  );
  latest.document = editor.document;
  if (!editor.document) return null;
  return (
    <EnclosureTab
      token="t"
      panel={PLAN}
      editor={editor}
      catalog={state}
      readOnly={readOnly}
      onNotice={onNotice}
      onError={onError}
      load3D={load3D}
      reloadPage={reloadPage}
    />
  );
}

function current(): PanelDocument {
  if (!latest.document) throw new Error("no document");
  return latest.document;
}

/** React's dev build re-throws a caught render error through a window "error" event; jsdom would print it. */
const quietWindowError = (event: ErrorEvent) => event.preventDefault();

const deviceIds = (doc: PanelDocument) => doc.rows.flatMap((candidate) => candidate.devices.map((device) => device.id));
const sheetBackdrops = () => document.querySelectorAll(".sp-sheet-backdrop");

beforeEach(() => {
  vi.mocked(updatePanel).mockReset();
  vi.mocked(updatePanel).mockResolvedValue(PLAN);
  latest.document = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("EnclosureTab — no cabinet yet", () => {
  it("shows the empty state, and the picker sets the cabinet", () => {
    render(<Host initial={emptyDocument()} />);
    expect(screen.getByText("Noch kein Schrank geplant.")).toBeInTheDocument();
    expect(screen.getByText("Hager univers Z, 1100 oder 1400 mm hoch, 2 bis 5 Felder.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Schrank wählen" }));
    const picker = screen.getByRole("dialog", { name: "Schrank wählen" });
    expect(within(picker).getByRole("region", { name: "1100 mm hoch" })).toBeInTheDocument();
    expect(within(picker).getByRole("region", { name: "1400 mm hoch" })).toBeInTheDocument();
    fireEvent.click(within(picker).getByRole("button", { name: /^ZB33S · 3 Felder/ }));

    expect(current().enclosure?.code).toBe("ZB33S");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sheetBackdrops()).toHaveLength(0);
    // The cabinet's toolbar and the field bar's add buttons, one per free field.
    expect(screen.getByRole("button", { name: "Offen" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Aufbau als PDF" })).toHaveAttribute("href", expect.stringContaining("/schaltplan/panels/7/aufbau/pdf"));
    for (const field of [1, 2, 3]) {
      expect(screen.getByRole("button", { name: new RegExp(`^\\+ Modul in Feld ${field}`) })).toBeInTheDocument();
    }
  });

  it("offers no choice on a read-only board", () => {
    render(<Host initial={emptyDocument()} readOnly />);
    expect(screen.getByText("Noch kein Schrank geplant.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Schrank wählen" })).toBeNull();
  });
});

describe("EnclosureTab — module picker", () => {
  function stockedCatalog(): EnclosureCatalog {
    const catalog = testCatalog();
    return {
      ...catalog,
      modules: catalog.modules.map((entry) => {
        if (entry.code === "ZU37KS") return { ...entry, stock_available: 2 };
        if (entry.code === "ZH3EL22") return { ...entry, recent_count: 3, last_used_at: "2026-10-01T08:00:00" };
        return entry;
      }),
    };
  }

  it("lists the shelf first, then recently used, then the catalogue, hides other heights and opens the placed module", () => {
    render(<Host initial={board([], { code: "ZB33S", modules: [] })} catalog={stockedCatalog()} />);
    fireEvent.click(screen.getByRole("button", { name: /^\+ Modul in Feld 1/ }));
    const picker = screen.getByRole("dialog", { name: "Modul für Feld 1" });

    const sections = within(picker)
      .getAllByRole("region")
      .map((section) => section.getAttribute("aria-labelledby"))
      .map((id) => window.document.getElementById(id ?? "")?.textContent);
    expect(sections).toEqual(["Im Lager", "Zuletzt verwendet", "Hager univers Z"]);
    expect(within(within(picker).getByRole("region", { name: "Im Lager" })).getByText("2 im Lager", { exact: false })).toBeInTheDocument();
    // ZH3EH16 is unverified in the test catalogue; ZH5EL27 is for 1350 mm fields.
    expect(within(picker).getByRole("button", { name: /^ZH3EH16,.*ungeprüft/ })).toBeInTheDocument();
    expect(within(picker).getByText("ungeprüft")).toHaveAttribute("title", "Katalogdaten nicht vollständig geprüft");
    expect(within(picker).getByText("1 Module für 1350 mm Felder ausgeblendet")).toBeInTheDocument();
    expect(within(picker).queryByRole("button", { name: /^ZH5EL27,/ })).toBeNull();

    fireEvent.click(within(picker).getByRole("button", { name: /^ZH3EH16,/ }));
    expect(current().enclosure?.modules.map((module) => module.code)).toEqual(["ZH3EH16"]);
    // The picker made way for the placed module's sheet.
    expect(screen.queryByRole("dialog", { name: "Modul für Feld 1" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Feld 1 · ZH3EH16" })).toBeInTheDocument();
    expect(sheetBackdrops()).toHaveLength(1);
  });

  it("opens the catalogue admin on the stack for managers, and back returns to the picker", () => {
    const catalog: EnclosureCatalog = { ...testCatalog(), can_manage: true };
    render(<Host initial={board([], { code: "ZB33S", modules: [] })} catalog={catalog} />);
    fireEvent.click(screen.getByRole("button", { name: /^\+ Modul in Feld 1/ }));
    fireEvent.click(screen.getByRole("button", { name: "Katalog verwalten" }));
    const admin = screen.getByRole("dialog", { name: "Schrankkatalog" });
    expect(sheetBackdrops()).toHaveLength(1);
    fireEvent.click(within(admin).getByRole("button", { name: "Zurück" }));
    expect(screen.getByRole("dialog", { name: "Modul für Feld 1" })).toBeInTheDocument();
  });

  it("keeps the picker's switches when a sheet opened on top of it closes again", () => {
    const catalog: EnclosureCatalog = { ...testCatalog(), can_manage: true };
    const legacy = board(
      [row("alt", [dev("hauptschalter", { id: "q1", designation: "Q1" }), dev("mcb", { id: "c1", designation: "F1.1" })])],
      { code: "ZB33S", modules: [] },
    );
    render(<Host initial={legacy} catalog={catalog} />);
    fireEvent.click(screen.getByRole("button", { name: /^\+ Modul in Feld 1/ }));
    const claim = () => screen.getByRole("checkbox", { name: "Vorhandene Geräte übernehmen" });
    const adopt = () => screen.getByRole("checkbox", { name: /^Vorhandene Reihen übernehmen/ });
    fireEvent.click(claim());
    fireEvent.click(adopt());

    fireEvent.click(screen.getByRole("button", { name: "Katalog verwalten" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Schrankkatalog" })).getByRole("button", { name: "Zurück" }));
    expect(screen.getByRole("dialog", { name: "Modul für Feld 1" })).toBeInTheDocument();
    expect(claim()).not.toBeChecked();
    expect(adopt()).toBeChecked();

    // Q1 stays outside the cabinet, as the fitter chose before the detour.
    fireEvent.click(screen.getByRole("button", { name: /^ZH3EH16,/ }));
    const q1 = current().rows.flatMap((candidate) => candidate.devices).find((device) => device.id === "q1");
    expect(q1?.supplied_by ?? null).toBeNull();
  });

  it("keeps the picker's search when a sheet opened on top of it closes again (R4 §8.1)", () => {
    const catalog: EnclosureCatalog = { ...testCatalog(), can_manage: true };
    render(<Host initial={board([], { code: "ZB33S", modules: [] })} catalog={catalog} />);
    fireEvent.click(screen.getByRole("button", { name: /^\+ Modul in Feld 1/ }));
    const search = () => within(screen.getByRole("dialog", { name: "Modul für Feld 1" })).getByRole("searchbox", { name: "Modul suchen" });
    fireEvent.change(search(), { target: { value: "zu37" } });
    // Escape typed into the box is the box's: the picker stays.
    fireEvent.keyDown(search(), { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Modul für Feld 1" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Katalog verwalten" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Schrankkatalog" })).getByRole("button", { name: "Zurück" }));
    const picker = screen.getByRole("dialog", { name: "Modul für Feld 1" });
    expect(search()).toHaveValue("zu37");
    // ZU37KS, ZU37RK, ZU37VT5APZ2 (nothing is archived in the plain test catalogue).
    expect(within(picker).getByRole("status")).toHaveTextContent("3 Treffer");
    expect(within(picker).queryByRole("button", { name: /^ZH3EH16,/ })).toBeNull();

    // A placed module ends the picker, and its query with it.
    fireEvent.click(within(picker).getByRole("button", { name: /^ZU37KS,/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Feld 1 · ZU37KS" })).getByRole("button", { name: "Schließen" }));
    fireEvent.click(screen.getByRole("button", { name: /^\+ Modul in Feld 2/ }));
    expect(screen.getByRole("dialog", { name: "Modul für Feld 2" })).toBeInTheDocument();
    expect(within(screen.getByRole("dialog", { name: "Modul für Feld 2" })).getByRole("searchbox", { name: "Modul suchen" })).toHaveValue("");
  });

  it("from the admin's form, Escape and the backdrop go back to its list — asking first when something was typed", () => {
    const catalog: EnclosureCatalog = { ...testCatalog(), can_manage: true };
    render(<Host initial={board([], { code: "ZB33S", modules: [] })} catalog={catalog} />);
    fireEvent.click(screen.getByRole("button", { name: /^\+ Modul in Feld 1/ }));
    fireEvent.click(screen.getByRole("button", { name: "Katalog verwalten" }));
    const admin = () => screen.getByRole("dialog", { name: /^(Schrankkatalog|Eintrag anlegen)$/ });
    fireEvent.click(within(admin()).getByRole("button", { name: "Eintrag anlegen" }));

    // Nothing typed yet: Escape is the form's ‹ — back to the list, not to the picker.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Schrankkatalog" })).toBeInTheDocument();

    fireEvent.click(within(admin()).getByRole("button", { name: "Eintrag anlegen" }));
    const code = within(screen.getByRole("region", { name: "Angaben" })).getByLabelText("Code");
    fireEvent.change(code, { target: { value: "ZX37NEU" } });
    const json = within(admin()).getByRole("textbox", { name: "Aufbau (JSON, für Fortgeschrittene)" });
    // Escape inside the JSON belongs to the field: nothing closes, nothing asks.
    fireEvent.keyDown(json, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Eintrag anlegen" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /^Eingaben verwerfen\?/ })).toBeNull();

    // A stray tap beside the sheet asks before the draft goes.
    fireEvent.click(sheetBackdrops()[0]);
    const ask = screen.getByRole("group", { name: /^Eingaben verwerfen\?/ });
    fireEvent.click(within(ask).getByRole("button", { name: "Weiter bearbeiten" }));
    expect((within(screen.getByRole("region", { name: "Angaben" })).getByLabelText("Code") as HTMLInputElement).value).toBe("ZX37NEU");

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(within(screen.getByRole("group", { name: /^Eingaben verwerfen\?/ })).getByRole("button", { name: "Ja, verwerfen" }));
    expect(screen.getByRole("dialog", { name: "Schrankkatalog" })).toBeInTheDocument();
    // And from the list the stack goes back as always: to the picker.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Modul für Feld 1" })).toBeInTheDocument();
  });

  it("offers no catalogue admin without werkstatt:manage", () => {
    render(<Host initial={board([], { code: "ZB33S", modules: [] })} />);
    fireEvent.click(screen.getByRole("button", { name: /^\+ Modul in Feld 1/ }));
    expect(screen.queryByRole("button", { name: "Katalog verwalten" })).toBeNull();
  });

  it("places at the free unit tapped in the drawing", () => {
    render(<Host initial={board([], { code: "ZB33S", modules: [mod("m4", "ZU62A", 1)] })} />);
    fireEvent.click(screen.getByRole("button", { name: /^Freier Platz in Feld 2, Höhe 3 von/ }));
    const picker = screen.getByRole("dialog", { name: "Modul für Feld 2" });
    fireEvent.click(within(picker).getByRole("button", { name: /^ZU62A,/ }));
    const placed = current().enclosure!.modules.filter((module) => module.id !== "m4");
    expect(placed).toEqual([expect.objectContaining({ code: "ZU62A", field: 1, unit: 2 })]);
  });
});

describe("EnclosureTab — read-only board", () => {
  it("draws free units as no buttons, and rails still open their sheet to read", () => {
    const initial = board(
      [row("vt1", [dev("rcd", { id: "fi1", designation: "F1" }), dev("mcb", { id: "ls1", designation: "F1.1" })], "F2 · Verteiler 1")],
      { code: "ZB33S", modules: [mod("m2", "ZU37KS", 1, { r1: "vt1" })] },
    );
    render(<Host initial={initial} readOnly />);
    expect(screen.queryAllByRole("button", { name: /^Freier Platz/ })).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Gerät F1.1 auf F2 · Verteiler 1" }));
    expect(screen.getByRole("dialog", { name: "F2 · Verteiler 1" })).toBeInTheDocument();
  });
});

describe("EnclosureTab — field bar", () => {
  it("has one button per module and an add button per field with room", () => {
    render(<Host initial={board([], { code: "ZB33S", modules: [mod("m1", "ZH3EH16", 0), mod("m2", "ZU37KS", 1)] })} />);
    const bar = screen.getByRole("navigation", { name: "Module im Schrank" });
    expect(within(bar).queryByRole("button", { name: /^\+ Modul in Feld 1/ })).toBeNull();
    expect(within(bar).getByRole("button", { name: /^\+ Modul in Feld 3/ })).toBeInTheDocument();

    fireEvent.click(within(bar).getByRole("button", { name: /^Feld 2 · ZU37KS/ }));
    expect(screen.getByRole("dialog", { name: "Feld 2 · ZU37KS" })).toBeInTheDocument();
  });
});

describe("EnclosureTab — feeds", () => {
  function hsBoard(): PanelDocument {
    return board(
      [row("aar1", [dev("hauptschalter", { id: "hs1", designation: "Q1", supplied_by: { module: "m1", part: "hs" } }), dev("mcb", { id: "ls1", designation: "F2" })], "F1 · AAR 1")],
      { code: "ZB33S", modules: [mod("m1", "ZH3EH16", 0, { aar1: "aar1" })] },
    );
  }

  it("asks before an op re-feeds a circuit, and applies only on 'Trotzdem ausführen'", () => {
    render(<Host initial={hsBoard()} />);
    fireEvent.click(screen.getByRole("button", { name: /^Feld 1 · ZH3EH16/ }));
    fireEvent.click(screen.getByRole("button", { name: "Hauptschalter entfernen" }));

    const confirm = screen.getByRole("alertdialog", { name: "Stromkreise ändern ihre Einspeisung" });
    expect(within(confirm).getByText("F2: Q1 → Einspeisung")).toBeInTheDocument();
    expect(deviceIds(current())).toContain("hs1");
    expect(sheetBackdrops()).toHaveLength(1);

    fireEvent.click(within(confirm).getByRole("button", { name: "Abbrechen" }));
    expect(deviceIds(current())).toContain("hs1");
    // Cancel returns to the module, which is still open.
    expect(screen.getByRole("dialog", { name: "Feld 1 · ZH3EH16" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Hauptschalter entfernen" }));
    fireEvent.click(screen.getByRole("button", { name: "Trotzdem ausführen" }));
    expect(deviceIds(current())).not.toContain("hs1");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const hs = within(screen.getByRole("dialog", { name: "Feld 1 · ZH3EH16" })).getByRole("listitem", { name: "Hauptschalter" });
    expect(within(hs).getByText("entfernt → ins Lager", { exact: false })).toBeInTheDocument();
  });

  it("orders the rows physically and says which circuits were pinned", () => {
    const onNotice = vi.fn();
    // rowC is outside the cabinet but stored between the two rails: LS b1
    // hangs positionally off FI F2. In the cabinet's order it would fall
    // under FI F1 — so it is pinned to F2.
    const initial = board(
      [
        row("rowA", [dev("rcd", { id: "f1", designation: "F1" }), dev("mcb", { id: "a1", designation: "F1.1" })], "F1 · Verteiler 1"),
        row("rowC", [dev("rcd", { id: "f2", designation: "F2" })], "Reihe alt"),
        row("rowB", [dev("mcb", { id: "b1", designation: "F2.1" })], "F1 · Verteiler 2"),
      ],
      { code: "ZB33S", modules: [mod("m2", "ZU37KS", 0, { r1: "rowA", r2: "rowB" })] },
    );
    render(<Host initial={initial} onNotice={onNotice} />);
    const order = screen.getByRole("button", { name: "Reihen ordnen" });
    expect(order).toBeEnabled();
    fireEvent.click(order);

    expect(current().rows.map((candidate) => candidate.id)).toEqual(["rowA", "rowB", "rowC"]);
    const b1 = current().rows[1].devices[0];
    expect(b1.parent_id).toBe("f2");
    expect(onNotice).toHaveBeenCalledWith("1 Stromkreis(e) behalten ihre Einspeisung — fest eingetragen.");
    expect(screen.getByRole("button", { name: "Reihen geordnet" })).toBeDisabled();
  });

  it("saves what an op did", async () => {
    vi.useFakeTimers();
    render(<Host initial={board([], { code: "ZB33S", modules: [] })} />);
    fireEvent.click(screen.getByRole("button", { name: /^\+ Modul in Feld 2/ }));
    fireEvent.click(screen.getByRole("button", { name: /^ZU37KS,/ }));
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(updatePanel).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(updatePanel).mock.calls[0][2].document as PanelDocument;
    expect(saved.enclosure?.modules).toEqual([expect.objectContaining({ code: "ZU37KS", field: 1, unit: 0 })]);
  });
});

describe("EnclosureTab — sheet stack", () => {
  // On r3: r1 and r2 of a Verteilerfeld are its terminal rails since round 2 (PANEL_ENCLOSURE_R2.md R2), where nothing new goes.
  function distributionBoard(): PanelDocument {
    return board(
      [row("vt1", [dev("rcd", { id: "fi1", designation: "F1" }), dev("mcb", { id: "ls1", designation: "F1.1" })], "F2 · Verteiler 3")],
      { code: "ZB33S", modules: [mod("m2", "ZU37KS", 1, { r3: "vt1" })] },
    );
  }

  it("opens the rail from the drawing, the inspector on top, and closing the inspector returns to the rail", () => {
    render(<Host initial={distributionBoard()} />);
    fireEvent.click(screen.getByRole("button", { name: "Gerät F1.1 auf F2 · Verteiler 3" }));
    const rail = screen.getByRole("dialog", { name: "F2 · Verteiler 3" });
    const tile = within(rail).getByRole("button", { name: /^F1\.1, Leitungsschutzschalter/ });
    expect(tile).toHaveAttribute("aria-current", "true");

    fireEvent.click(within(rail).getByRole("button", { name: /^F1, FI-Schutzschalter/ }));
    expect(screen.getByRole("dialog", { name: "FI-Schutzschalter (RCD)" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "F2 · Verteiler 3" })).toBeNull();
    expect(sheetBackdrops()).toHaveLength(1);

    fireEvent.click(within(screen.getByRole("dialog", { name: "FI-Schutzschalter (RCD)" })).getByRole("button", { name: "Schließen" }));
    expect(screen.getByRole("dialog", { name: "F2 · Verteiler 3" })).toBeInTheDocument();
    expect(sheetBackdrops()).toHaveLength(1);

    // The backdrop pops one sheet; the last one closes the stack.
    fireEvent.click(sheetBackdrops()[0]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sheetBackdrops()).toHaveLength(0);
  });

  it("gives the stack's inspector and palette the stack's 56 px targets", () => {
    render(<Host initial={distributionBoard()} />);
    fireEvent.click(screen.getByRole("button", { name: "Gerät F1.1 auf F2 · Verteiler 3" }));
    fireEvent.click(screen.getByRole("button", { name: /^F1\.1, Leitungsschutzschalter/ }));
    expect(screen.getByRole("dialog", { name: "Leitungsschutzschalter" })).toHaveClass("sp-sheet--glove");
    fireEvent.click(within(screen.getByRole("dialog", { name: "Leitungsschutzschalter" })).getByRole("button", { name: "Schließen" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "F2 · Verteiler 3" })).getByRole("button", { name: "+ Gerät" }));
    expect(screen.getByRole("dialog", { name: "Gerät hinzufügen" })).toHaveClass("sp-sheet--glove");
  });

  it("edits a device from the inspector inside the stack", () => {
    render(<Host initial={distributionBoard()} />);
    fireEvent.click(screen.getByRole("button", { name: "Gerät F1.1 auf F2 · Verteiler 3" }));
    fireEvent.click(screen.getByRole("button", { name: /^F1\.1, Leitungsschutzschalter/ }));
    const inspector = screen.getByRole("dialog", { name: "Leitungsschutzschalter" });
    fireEvent.change(within(inspector).getByPlaceholderText("z. B. Steckdosen Küche"), { target: { value: "Licht Flur" } });
    expect(current().rows[0].devices[1].label).toBe("Licht Flur");

    fireEvent.click(within(inspector).getByRole("button", { name: "Vorheriges Gerät" }));
    expect(screen.getByRole("dialog", { name: "FI-Schutzschalter (RCD)" })).toBeInTheDocument();
  });

  it("closes back to the rail after deleting a device", () => {
    render(<Host initial={distributionBoard()} />);
    fireEvent.click(screen.getByRole("button", { name: "Gerät F1.1 auf F2 · Verteiler 3" }));
    fireEvent.click(screen.getByRole("button", { name: /^F1\.1, Leitungsschutzschalter/ }));
    fireEvent.click(screen.getByRole("button", { name: "Löschen" }));
    fireEvent.click(screen.getByRole("button", { name: "Wirklich löschen?" }));
    expect(deviceIds(current())).toEqual(["fi1"]);
    expect(screen.getByRole("dialog", { name: "F2 · Verteiler 3" })).toBeInTheDocument();
  });

  it("adds a device through the palette and opens it", () => {
    render(<Host initial={distributionBoard()} />);
    fireEvent.click(screen.getByRole("button", { name: /^Hutschiene F2 · Verteiler 4 · leer/ }));
    const rail = screen.getByRole("dialog", { name: "F2 · Verteiler 4" });
    fireEvent.click(within(rail).getByRole("button", { name: "+ Gerät" }));

    const palette = screen.getByRole("dialog", { name: "Gerät hinzufügen" });
    // Not a cabinet-only part on a distribution rail? The HLAK is offered on every cabinet board.
    expect(within(palette).getByText("Hauptleitungsabzweigklemme (HLAK)")).toBeInTheDocument();
    expect(within(palette).getByText("Zwischenzähler (Hutschiene)")).toBeInTheDocument();
    fireEvent.click(within(palette).getByRole("button", { name: /^Leitungsschutzschalter/ }));

    expect(screen.queryByRole("dialog", { name: "Gerät hinzufügen" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Leitungsschutzschalter" })).toBeInTheDocument();
    const added = current().rows.find((candidate) => candidate.label === "F2 · Verteiler 4");
    expect(added?.devices.map((device) => device.kind)).toEqual(["mcb"]);
    expect(current().enclosure!.modules[0].rails.r4).toBe(added?.id);

    fireEvent.click(within(screen.getByRole("dialog", { name: "Leitungsschutzschalter" })).getByRole("button", { name: "Schließen" }));
    expect(within(screen.getByRole("dialog", { name: "F2 · Verteiler 4" })).getByRole("button", { name: /Leitungsschutzschalter/ })).toBeInTheDocument();
  });

  it("moves a device to another rail from the inspector", () => {
    render(<Host initial={distributionBoard()} />);
    fireEvent.click(screen.getByRole("button", { name: "Gerät F1.1 auf F2 · Verteiler 3" }));
    fireEvent.click(screen.getByRole("button", { name: /^F1\.1, Leitungsschutzschalter/ }));
    fireEvent.click(screen.getByRole("button", { name: "Auf andere Hutschiene…" }));
    const picker = screen.getByRole("dialog", { name: "Hutschiene wählen" });
    fireEvent.click(within(picker).getByRole("button", { name: /^Feld 2 · Verteiler 5 · / }));

    const target = current().rows.find((candidate) => candidate.devices.some((device) => device.id === "ls1"));
    expect(current().enclosure!.modules[0].rails.r5).toBe(target?.id);
    // Round 2 (PANEL_ENCLOSURE_R2.md §6.5): the sheets close and the drop note offers Rückgängig.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Rückgängig" })).toBeInTheDocument();
  });

  it("pops one sheet on Escape", () => {
    render(<Host initial={distributionBoard()} />);
    fireEvent.click(screen.getByRole("button", { name: "Gerät F1.1 auf F2 · Verteiler 3" }));
    fireEvent.click(screen.getByRole("button", { name: /^F1\.1, Leitungsschutzschalter/ }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "F2 · Verteiler 3" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the pre-fitted banner in the stack's inspector", () => {
    const initial = board(
      [row("aar1", [dev("hauptschalter", { id: "hs1", designation: "Q1", supplied_by: { module: "m1", part: "hs" } })], "F1 · AAR 1")],
      { code: "ZB33S", modules: [mod("m1", "ZH3EH16", 0, { aar1: "aar1" })] },
    );
    render(<Host initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Gerät Q1 auf F1 · AAR 1 · vorbestückt" }));
    fireEvent.click(screen.getByRole("button", { name: /^Q1, Hauptschalter/ }));
    const inspector = screen.getByRole("dialog", { name: "Hauptschalter" });
    expect(within(inspector).getByText("Vorbestückt in ZH3EH16")).toBeInTheDocument();
    expect(within(inspector).getByText("Katalog ungeprüft: angenommen")).toBeInTheDocument();
  });
});

describe("EnclosureTab — views and findings", () => {
  function meterBoard(): PanelDocument {
    return board([], { code: "ZB33S", modules: [mod("m1", "ZH3EH16", 0, {}, { meters: [{ place: 0, number: "1EBZ0100000009", label: "" }] })] });
  }

  it("lists the findings with the disclaimer", () => {
    render(<Host initial={meterBoard()} />);
    const findings = screen.getByRole("region", { name: "Hinweise zum Schrank" });
    expect(within(findings).getByText("Prüfhilfe nach VDE-AR-N 4100:2026-04 — ersetzt nicht die TAB des Netzbetreibers.")).toBeInTheDocument();
    // R4 §4: the supply kit and the APZ are derived now; what no rule can see is the VNB's SABO approval.
    expect(
      within(findings).getByText(
        "Nicht automatisch geprüft: Zulassung der SABO durch den Netzbetreiber · RJ45-Dose im RfZ · Einführung des Hauptkabels nicht von oben · Montagehöhe und Arbeitsraum · TAB des Netzbetreibers.",
      ),
    ).toBeInTheDocument();
    expect(within(findings).getByText(/Kein APZ im Schrank/)).toBeInTheDocument();
  });

  it("switches to the closed view", () => {
    render(<Host initial={meterBoard()} />);
    fireEvent.click(screen.getByRole("button", { name: "Geschlossen" }));
    expect(screen.getByRole("group", { name: /geschlossen$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Geschlossen" })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps a failed 3D chunk inside the tab and retries with a fresh import", async () => {
    let calls = 0;
    const load3D: Enclosure3DLoader = () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("chunk gone"));
      return Promise.resolve({ default: () => <p>3D-Attrappe</p> });
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<Host initial={meterBoard()} load3D={load3D} />);
    fireEvent.click(screen.getByRole("button", { name: "3D" }));
    expect(await screen.findByText("3D konnte nicht geladen werden.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "3D neu laden" }));
    expect(await screen.findByText("3D-Attrappe")).toBeInTheDocument();
    expect(calls).toBe(2);
    consoleError.mockRestore();
  });

  it("offers to reload the page — after saving — when 3D neu laden fails too (a stale tab after a deploy)", async () => {
    const reloadPage = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    window.addEventListener("error", quietWindowError);
    render(<Host initial={meterBoard()} load3D={() => Promise.reject(new Error("chunk gone"))} reloadPage={reloadPage} />);
    // An edit still waiting for its autosave.
    fireEvent.click(screen.getByRole("button", { name: /^\+ Modul in Feld 2/ }));
    fireEvent.click(screen.getByRole("button", { name: /^ZU37KS,/ }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(updatePanel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "3D" }));
    expect(await screen.findByText("3D konnte nicht geladen werden.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Seite neu laden" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "3D neu laden" }));
    const reload = await screen.findByRole("button", { name: "Seite neu laden" });
    expect(screen.getByText(/nach einem Update/i)).toBeInTheDocument();
    fireEvent.click(reload);
    await waitFor(() => expect(reloadPage).toHaveBeenCalledTimes(1));
    expect(updatePanel).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updatePanel).mock.invocationCallOrder[0]).toBeLessThan(reloadPage.mock.invocationCallOrder[0]);
    window.removeEventListener("error", quietWindowError);
    consoleError.mockRestore();
  });

  it("does not reload the page when the save fails — the edits would be lost", async () => {
    vi.mocked(updatePanel).mockRejectedValue(new TypeError("Failed to fetch"));
    const onError = vi.fn();
    const reloadPage = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    window.addEventListener("error", quietWindowError);
    render(<Host initial={meterBoard()} load3D={() => Promise.reject(new Error("chunk gone"))} reloadPage={reloadPage} onError={onError} />);
    fireEvent.click(screen.getByRole("button", { name: /^\+ Modul in Feld 2/ }));
    fireEvent.click(screen.getByRole("button", { name: /^ZU37KS,/ }));
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "3D" }));
    fireEvent.click(await screen.findByRole("button", { name: "3D neu laden" }));
    fireEvent.click(await screen.findByRole("button", { name: "Seite neu laden" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith(PAGE_NOT_SAVED));
    expect(reloadPage).not.toHaveBeenCalled();
    window.removeEventListener("error", quietWindowError);
    consoleError.mockRestore();
  });

  it("says when the device has no WebGL", async () => {
    render(<Host initial={meterBoard()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "3D" }));
    });
    await waitFor(
      () => expect(screen.getByText("3D ist auf diesem Gerät nicht verfügbar — die 2D-Ansicht zeigt dasselbe.")).toBeInTheDocument(),
      { timeout: 10_000 },
    );
  });
});
