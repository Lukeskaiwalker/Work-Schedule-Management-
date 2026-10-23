/**
 * "Modul für Feld {n}" (docs/PANEL_ENCLOSURE.md §3.4, §11): what is on the
 * shelf first, then what this login used lately, then the rest of the
 * catalogue; modules for the other field height hidden but counted; the
 * placement at the tapped unit when the module fits there, else at the top
 * of a free run; the claim preview and its switch; the managers' extras.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";

import { ModulePickerSheet } from "../components/schaltplan/enclosure/ModulePickerSheet";
import { catalogIndex } from "../utils/enclosureCatalog";
import { linkedRows } from "../utils/enclosureLayout";
import { placeModule } from "../utils/enclosureOps";
import { board, dev, INDEX, MODULES, row, testCatalog } from "./enclosureTestCatalog";
import { renderSheet } from "./enclosureSheetHarness";
import type { EnclosureCatalog, ModuleSpec } from "../types/panelEnclosure";
import type { PanelDocument } from "../types/schaltplan";

function shelfCatalog(): EnclosureCatalog {
  const base = testCatalog();
  const modules = base.modules.map((entry) => {
    if (entry.code === "ZU37KS") return { ...entry, stock_available: 2 };
    if (entry.code === "ZH3EL27") return { ...entry, recent_count: 3, last_used_at: "2026-10-01T08:00:00Z" };
    if (entry.code === "ZU37RK") return { ...entry, archived: true };
    return entry;
  });
  // The server's order: stock first, then recent, then the catalogue.
  const rank = (code: string) => (code === "ZU37KS" ? 0 : code === "ZH3EL27" ? 1 : 2);
  return { ...base, modules: [...modules].sort((a, b) => rank(a.code) - rank(b.code)) };
}

const CATALOG = shelfCatalog();
const SHELF_INDEX = catalogIndex(CATALOG);

/** Two invented entries a Werkstatt manager might add: a 300 mm cover, and a cover two fields wide. */
const coverZone = MODULES.ZU62A.zones[0];
const COVER_300: ModuleSpec = { ...MODULES.ZU62A, code: "ZX79A", article_no: "ZX79A", name: "Abdeckung (erfunden)", height_units: 2, zones: [{ ...coverZone, units: 2 }] };
const WIDE_COVER: ModuleSpec = {
  ...MODULES.ZU62A,
  code: "ZX2W3",
  article_no: "ZX2W3",
  name: "Abdeckung über zwei Felder (erfunden)",
  width_fields: 2,
  height_units: 3,
  zones: [{ ...coverZone, units: 3 }],
};
const CUSTOM_CATALOG = testCatalog({ modules: { ZX79A: COVER_300, ZX2W3: WIDE_COVER } });

const cabinet = (rows = board([]).rows): PanelDocument => board(rows, { code: "ZB33S", modules: [] });

function place(document: PanelDocument, code: string, field: number, unit: number): PanelDocument {
  const result = placeModule(document, INDEX, { code, field, unit, claim: false });
  if (!result.ok) throw new Error(result.error);
  return result.document;
}

type Extra = {
  field?: number;
  unit?: number | null;
  catalog?: EnclosureCatalog;
  onPlaced?: (moduleId: string) => void;
  onManageCatalog?: () => void;
  onCreateEntry?: (item: EnclosureCatalog["uncatalogued"][number]) => void;
};

function open(document: PanelDocument, extra: Extra = {}) {
  const catalog = extra.catalog ?? CATALOG;
  const index = catalogIndex(catalog);
  return renderSheet(
    document,
    ({ document: current, onOp }) => (
      <ModulePickerSheet
        document={current}
        catalog={catalog}
        index={index}
        field={extra.field ?? 0}
        unit={extra.unit ?? null}
        readOnly={false}
        onOp={onOp}
        onPlaced={extra.onPlaced}
        onManageCatalog={extra.onManageCatalog}
        onCreateEntry={extra.onCreateEntry}
        onClose={vi.fn()}
      />
    ),
    index,
  );
}

const item = (code: string) => screen.getByRole("button", { name: new RegExp(`^${code}\\b`) });

describe("ModulePickerSheet — sections and filters", () => {
  it("lists Im Lager, Zuletzt verwendet, Hager univers Z in that order", () => {
    open(cabinet());
    const dialog = screen.getByRole("dialog", { name: "Modul für Feld 1" });
    const headings = within(dialog).getAllByRole("heading", { level: 4 }).map((heading) => heading.textContent);
    expect(headings).toEqual(["Im Lager", "Zuletzt verwendet", "Hager univers Z"]);
    const sections = within(dialog).getAllByRole("region");
    expect(within(sections[0]).getByRole("button", { name: /^ZU37KS\b/ })).toHaveTextContent("2 im Lager");
    expect(within(sections[1]).getByRole("button", { name: /^ZH3EL27\b/ })).toBeInTheDocument();
    expect(within(sections[2]).getByRole("button", { name: /^ZH3EH16\b/ })).toBeInTheDocument();
  });

  it("hides archived modules and the other field height, and says how many", () => {
    open(cabinet());
    expect(screen.queryByRole("button", { name: /^ZU37RK\b/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^ZH5EL27\b/ })).toBeNull();
    expect(screen.getByText("1 Module für 1350 mm Felder ausgeblendet")).toBeInTheDocument();
    // Height-free modules (covers, RfZ) fit any cabinet.
    expect(item("ZU62A")).toBeEnabled();
    expect(item("ZY150RFZ")).toBeEnabled();
  });

  it("marks unverified catalogue data", () => {
    open(cabinet());
    const badge = within(item("ZH3EH16")).getByText("ungeprüft");
    expect(badge).toHaveAttribute("title", "Katalogdaten nicht vollständig geprüft");
    expect(within(item("ZU37KS")).queryByText("ungeprüft")).toBeNull();
  });

  it("says why a module does not fit and refuses it", () => {
    const { current } = open(place(cabinet(), "ZU62A", 0, 3));
    const tall = item("ZU37KS");
    expect(tall).toBeDisabled();
    expect(tall).toHaveTextContent("passt hier nicht: Nicht genug Platz: 1050 mm nötig, 450 mm frei.");
    fireEvent.click(tall);
    expect(current().enclosure?.modules).toHaveLength(1);
  });

  it("places nothing read-only", () => {
    renderSheet(cabinet(), ({ document: current, onOp }) => (
      <ModulePickerSheet document={current} catalog={CATALOG} index={SHELF_INDEX} field={0} unit={null} readOnly onOp={onOp} onClose={vi.fn()} />
    ), SHELF_INDEX);
    expect(item("ZU37KS")).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Vorhandene Geräte übernehmen" })).toBeDisabled();
  });

  it("shows nothing to place without a cabinet", () => {
    open(board([]));
    expect(screen.getByText("Noch kein Schrank geplant.")).toBeInTheDocument();
  });
});

describe("ModulePickerSheet — placement", () => {
  it("places at the tapped unit when the module fits there", () => {
    const onPlaced = vi.fn();
    const { current } = open(place(cabinet(), "ZU62A", 0, 3), { unit: 5, onPlaced });
    fireEvent.click(item("ZY150RFZ"));
    const placed = current().enclosure!.modules.find((module) => module.code === "ZY150RFZ")!;
    expect(placed).toMatchObject({ field: 0, unit: 5 });
    expect(onPlaced).toHaveBeenCalledWith(placed.id);
  });

  it("falls back to the top of a free run when the tapped unit is taken", () => {
    const { current } = open(place(cabinet(), "ZU62A", 1, 3), { field: 1, unit: 3 });
    fireEvent.click(item("ZY150RFZ"));
    const placed = current().enclosure!.modules.find((module) => module.code === "ZY150RFZ")!;
    expect(placed).toMatchObject({ field: 1, unit: 0 });
  });

  it("tapped low in the lower gap, goes to the top of that gap — not into the gap above", () => {
    // Field 1: free 0–1, covers at 2 and 3, free 4–6. The fitter taps unit 6 for a 300 mm part.
    const doc = place(place(cabinet(), "ZU62A", 0, 2), "ZU62A", 0, 3);
    const { current } = open(doc, { unit: 6, catalog: CUSTOM_CATALOG });
    fireEvent.click(item("ZX79A"));
    const placed = current().enclosure!.modules.find((module) => module.code === "ZX79A")!;
    expect(placed).toMatchObject({ field: 0, unit: 4 });
  });

  it("finds room for a module two fields wide below what stands in the second field", () => {
    // Field 2 holds three covers at the top; field 1 is empty. Unit 0 is free in field 1 only.
    const doc = place(place(place(cabinet(), "ZU62A", 1, 0), "ZU62A", 1, 1), "ZU62A", 1, 2);
    const { current } = open(doc, { catalog: CUSTOM_CATALOG });
    const wide = item("ZX2W3");
    expect(wide).toBeEnabled();
    expect(wide).not.toHaveTextContent("passt hier nicht");
    fireEvent.click(wide);
    const placed = current().enclosure!.modules.find((module) => module.code === "ZX2W3")!;
    expect(placed).toMatchObject({ field: 0, unit: 3 });
  });

  it("refuses a wide module with the reason of the roomiest place", () => {
    // Field 2 is full: nowhere in field 1 has a free neighbour for the second half.
    const doc = place(cabinet(), "ZU37KS", 1, 0);
    open(doc, { catalog: CUSTOM_CATALOG });
    const wide = item("ZX2W3");
    expect(wide).toBeDisabled();
    expect(wide).toHaveTextContent("passt hier nicht: Nicht genug Platz: 450 mm nötig, 0 mm frei.");
  });
});

describe("ModulePickerSheet — what an item says", () => {
  it("does not repeat a full-field module's height, which every listed one shares", () => {
    open(cabinet());
    expect(item("ZU37KS")).not.toHaveTextContent("1050 mm");
    expect(item("ZU37KS")).toHaveTextContent("2 im Lager");
  });

  it("says how tall a part is that fills only some of the field", () => {
    open(cabinet(), { catalog: CUSTOM_CATALOG });
    expect(item("ZU62A")).toHaveTextContent("150 mm hoch");
    expect(item("ZX79A")).toHaveTextContent("300 mm hoch");
  });
});

describe("ModulePickerSheet — taking over what exists", () => {
  const legacy = () =>
    cabinet([
      row("alt", [
        dev("hauptschalter", { id: "q1", designation: "Q1" }),
        dev("meter", { id: "p1", designation: "P1" }),
        dev("mcb", { id: "c1", designation: "F1.1" }),
      ]),
    ]);

  it("previews the claim and takes the devices over", () => {
    const { current } = open(legacy());
    expect(item("ZH3EH16")).toHaveTextContent("Übernimmt: Q1 (Hauptschalter), P1 → Zählerplatz");
    expect(screen.getByRole("checkbox", { name: "Vorhandene Geräte übernehmen" })).toBeChecked();
    fireEvent.click(item("ZH3EH16"));
    const doc = current();
    const hs = doc.rows.flatMap((candidate) => candidate.devices).filter((device) => device.kind === "hauptschalter");
    expect(hs.map((device) => device.id)).toEqual(["q1"]);
    expect(hs[0].supplied_by?.part).toBe("hs");
    expect(doc.rows.flatMap((candidate) => candidate.devices).some((device) => device.id === "p1")).toBe(false);
  });

  it("switched off, places fresh parts and leaves the devices alone", () => {
    const { current } = open(legacy());
    fireEvent.click(screen.getByRole("checkbox", { name: "Vorhandene Geräte übernehmen" }));
    expect(item("ZH3EH16")).not.toHaveTextContent("Übernimmt:");
    fireEvent.click(item("ZH3EH16"));
    const devices = current().rows.flatMap((candidate) => candidate.devices);
    expect(devices.find((device) => device.id === "q1")?.supplied_by ?? null).toBeNull();
    expect(devices.filter((device) => device.kind === "hauptschalter")).toHaveLength(2);
    expect(devices.some((device) => device.id === "p1")).toBe(true);
  });

  it("hangs the outside rows onto a distribution field's rails when asked", () => {
    const { current } = open(cabinet([row("alt", [dev("mcb", { id: "c1" })]), row("leer", [])]));
    const adopt = screen.getByRole("checkbox", { name: "Vorhandene Reihen übernehmen (1)" });
    expect(adopt).not.toBeChecked();
    fireEvent.click(adopt);
    fireEvent.click(item("ZU37KS"));
    const links = linkedRows(current(), SHELF_INDEX);
    // The first rail that is no terminal rail (r1/r2 are reserved for WAGO terminals, R2 §3.6).
    expect(links.get("alt")?.railKey).toBe("r3");
  });

  it("offers no row take-over without outside rows that hold devices", () => {
    open(cabinet([row("leer", [])]));
    expect(screen.queryByRole("checkbox", { name: /Vorhandene Reihen übernehmen/ })).toBeNull();
  });
});

describe("ModulePickerSheet — managers", () => {
  const managed = (): EnclosureCatalog => ({
    ...CATALOG,
    can_manage: true,
    uncatalogued: [
      {
        article: {
          id: 7,
          article_number: "ZU37X9",
          item_name: "Hager ZU37X9 Feldeinbausatz",
          manufacturer: "Hager",
          unit: "Stk",
          internal_code: null,
          stock_available: 3,
        },
        code_guess: "ZU37X9",
      },
    ],
  });

  it("lists shelf articles the catalogue lacks and opens the admin", () => {
    const onCreateEntry = vi.fn();
    const onManageCatalog = vi.fn();
    open(cabinet(), { catalog: managed(), onCreateEntry, onManageCatalog });
    const section = screen.getByRole("region", { name: "Im Lager, nicht im Katalog" });
    expect(section).toHaveTextContent("Hager ZU37X9 Feldeinbausatz");
    expect(section).toHaveTextContent("3 im Lager");
    fireEvent.click(within(section).getByRole("button", { name: "Eintrag anlegen" }));
    expect(onCreateEntry).toHaveBeenCalledWith(managed().uncatalogued[0]);
    fireEvent.click(screen.getByRole("button", { name: "Katalog verwalten" }));
    expect(onManageCatalog).toHaveBeenCalledTimes(1);
  });

  it("shows neither to everyone else", () => {
    open(cabinet(), { onCreateEntry: vi.fn(), onManageCatalog: vi.fn() });
    expect(screen.queryByRole("region", { name: "Im Lager, nicht im Katalog" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Katalog verwalten" })).toBeNull();
  });
});
