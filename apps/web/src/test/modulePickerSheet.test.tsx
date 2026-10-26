/**
 * "Modul für Feld {n}" (docs/PANEL_ENCLOSURE.md §3.4, §11): what is on the
 * shelf first, then what this login used lately, then the rest of the
 * catalogue; modules for the other field height hidden but counted; the
 * placement at the tapped unit when the module fits there, else at the top
 * of a free run; the claim preview and its switch; the managers' extras;
 * the search box (docs/PANEL_ENCLOSURE_R4.md §8.1).
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { ModulePickerSheet } from "../components/schaltplan/enclosure/ModulePickerSheet";
import { SheetFrame } from "../components/schaltplan/enclosure/EnclosureSheetFrame";
import {
  countHidden,
  filterSections,
  hiddenHint,
  moduleHaystack,
  noMatchText,
  searchPicker,
  searchStatus,
  uncataloguedHaystack,
} from "../components/schaltplan/enclosure/modulePickerSearch";
import { catalogIndex } from "../utils/enclosureCatalog";
import { linkedRows } from "../utils/enclosureLayout";
import { placeModule } from "../utils/enclosureOps";
import { buildSearchTokens } from "../utils/searchNormalize";
import { board, deepFreeze, dev, INDEX, MODULES, row, testCatalog } from "./enclosureTestCatalog";
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

// ── Search (docs/PANEL_ENCLOSURE_R4.md §8.1) ────────────────────────────────

/** An invented stock article mapped to ZH3EH16: what the shelf calls it. */
const ZH3EH16_ARTICLE = {
  id: 11,
  article_number: "WS-40817",
  item_name: "Feldbausatz Musterhaus (erfunden)",
  manufacturer: "Hager",
  unit: "Stk",
  internal_code: "INT-0042",
  stock_available: 0,
};

function articledCatalog(): EnclosureCatalog {
  return {
    ...CATALOG,
    modules: CATALOG.modules.map((entry) => (entry.code === "ZH3EH16" ? { ...entry, article: ZH3EH16_ARTICLE, article_source: "mapping" as const } : entry)),
  };
}

/** Two invented shelf articles the catalogue lacks (managers only). */
function shelfArticlesCatalog(): EnclosureCatalog {
  const article = (id: number, article_number: string, item_name: string) => ({
    id, article_number, item_name, manufacturer: "Hager", unit: "Stk", internal_code: null, stock_available: 1,
  });
  return {
    ...CATALOG,
    can_manage: true,
    uncatalogued: [
      { article: article(7, "ZU37X9", "Hager ZU37X9 Feldeinbausatz"), code_guess: "ZU37X9" },
      { article: article(8, "HG-55120", "Hager Zählerplatz-Abdeckung (erfunden)"), code_guess: "ZX99B" },
    ],
  };
}

const searchbox = () => screen.getByRole("searchbox", { name: "Modul suchen" });
const typeQuery = (value: string) => fireEvent.change(searchbox(), { target: { value } });
const status = () => within(screen.getByRole("dialog", { name: /^Modul für Feld/ })).getByRole("status");
const headings = () => screen.queryAllByRole("heading", { level: 4 }).map((heading) => heading.textContent);
/** The module items on screen, by code, top to bottom. */
const listedCodes = () =>
  screen.queryAllByRole("button", { name: /^Z[A-Z0-9]+,/ }).map((button) => (button.getAttribute("aria-label") ?? "").split(",")[0]);

describe("ModulePickerSheet — search box", () => {
  it("sits between the head and the scrolling list, set up for a workshop tablet, without a form", () => {
    open(cabinet());
    const input = searchbox();
    expect(input).toHaveAttribute("type", "search");
    expect(input).toHaveAttribute("placeholder", "Code, Bezeichnung oder Artikelnummer");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input).toHaveAttribute("autocorrect", "off");
    expect(input).toHaveAttribute("autocapitalize", "none");
    expect(input).toHaveAttribute("spellcheck", "false");
    expect(input).toHaveAttribute("enterkeyhint", "search");
    expect(input).not.toHaveFocus();
    expect(input.closest("form")).toBeNull();
    expect(screen.getByText("Modul suchen").tagName).toBe("LABEL");
    // The toolbar does not scroll away with the 30–40 modules under it.
    expect(input.closest(".sp-sheet-body")).toBeNull();
    const toolbar = input.closest(".sp-encl-sheet-toolbar");
    expect(toolbar?.previousElementSibling).toHaveClass("sp-sheet-head");
    expect(toolbar?.nextElementSibling).toHaveClass("sp-sheet-body");
  });

  it("keeps its status mounted: empty without a query, then the number of hits", () => {
    open(cabinet());
    expect(status()).toBeEmptyDOMElement();
    typeQuery("zu37");
    expect(status()).toHaveTextContent(/^2 Treffer$/);
    typeQuery("zu37ks");
    expect(status()).toHaveTextContent(/^1 Treffer$/);
    typeQuery("xyz");
    expect(status()).toHaveTextContent(/^Kein Treffer$/);
    typeQuery("   ");
    expect(status()).toBeEmptyDOMElement();
  });

  it("finds a module by a fragment of its code, with or without the punctuation", () => {
    open(cabinet());
    typeQuery("zu37");
    expect(listedCodes()).toEqual(["ZU37KS", "ZU37VT5APZ2"]);
    typeQuery("ZU-37 ks");
    expect(listedCodes()).toEqual(["ZU37KS"]);
  });

  it("finds Zähler typed as zaehler, zahler or Zähler", () => {
    open(cabinet());
    for (const query of ["zaehler", "zahler", "Zähler"]) {
      typeQuery(query);
      expect(listedCodes(), query).toEqual(["ZH3EL27", "ZH3EH16", "ZH3EL22", "ZH33X7"]);
    }
  });

  it("finds a module by its stock article's number, internal code and name", () => {
    open(cabinet(), { catalog: articledCatalog() });
    for (const query of ["WS-40817", "ws40817", "int-0042", "musterhaus"]) {
      typeQuery(query);
      expect(listedCodes(), query).toEqual(["ZH3EH16"]);
    }
  });

  it("finds modules by the zones they hold", () => {
    open(cabinet());
    typeQuery("SAS");
    expect(listedCodes()).toEqual(["ZH3ES5"]);
    typeQuery("RfZ");
    expect(listedCodes()).toEqual(["ZH3EL27", "ZH3EH16", "ZH3EL22", "ZY150RFZ"]);
    typeQuery("nar");
    expect(listedCodes()).toEqual(["ZH3EL27", "ZH3EH16", "ZH3EL22", "ZH33X7"]);
  });

  it("keeps the sections and the order inside them, and drops a section left empty", () => {
    open(cabinet());
    typeQuery("7");
    expect(headings()).toEqual(["Im Lager", "Zuletzt verwendet", "Hager univers Z"]);
    expect(listedCodes()).toEqual(["ZU37KS", "ZH3EL27", "ZH33X7", "ZU37VT5APZ2"]);
    expect(status()).toHaveTextContent(/^4 Treffer$/);
    typeQuery("zh3");
    expect(headings()).toEqual(["Zuletzt verwendet", "Hager univers Z"]);
    typeQuery("");
    expect(headings()).toEqual(["Im Lager", "Zuletzt verwendet", "Hager univers Z"]);
  });

  it("lists a match that does not fit, refused and counted as without a search", () => {
    open(place(cabinet(), "ZU62A", 0, 3));
    typeQuery("zu37ks");
    const tall = item("ZU37KS");
    expect(tall).toBeDisabled();
    expect(tall).toHaveTextContent("passt hier nicht: Nicht genug Platz: 1050 mm nötig, 450 mm frei.");
    expect(status()).toHaveTextContent(/^1 Treffer$/);
  });

  it("says when nothing matches, and its Suche löschen brings the whole list back", () => {
    open(cabinet());
    typeQuery("  xyz ");
    expect(screen.getByText("Kein Modul gefunden für „xyz“.")).toBeInTheDocument();
    expect(headings()).toEqual([]);
    expect(screen.getAllByRole("button", { name: "Suche löschen" })).toHaveLength(2);
    const clear = screen.getByText("Suche löschen", { selector: "button" });
    expect(clear).toHaveClass("sp-encl-target");
    fireEvent.click(clear);
    expect(searchbox()).toHaveValue("");
    expect(searchbox()).toHaveFocus();
    expect(headings()).toEqual(["Im Lager", "Zuletzt verwendet", "Hager univers Z"]);
    expect(screen.queryByText(/^Kein Modul gefunden/)).toBeNull();
  });

  it("offers × only while something is typed; it clears and gives the box the focus back", () => {
    open(cabinet());
    expect(screen.queryByRole("button", { name: "Suche löschen" })).toBeNull();
    typeQuery("zu37");
    const clear = screen.getByRole("button", { name: "Suche löschen" });
    expect(clear).toHaveTextContent("×");
    expect(clear).toHaveAttribute("type", "button");
    fireEvent.click(clear);
    expect(searchbox()).toHaveValue("");
    expect(searchbox()).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Suche löschen" })).toBeNull();
    expect(status()).toBeEmptyDOMElement();
  });

  it("Enter puts the keyboard away and keeps the query", () => {
    open(cabinet());
    const input = searchbox();
    input.focus();
    typeQuery("zu37");
    const notCancelled = fireEvent.keyDown(input, { key: "Enter" });
    expect(notCancelled).toBe(false);
    expect(input).not.toHaveFocus();
    expect(input).toHaveValue("zu37");
    expect(listedCodes()).toEqual(["ZU37KS", "ZU37VT5APZ2"]);
  });

  it("counts a hidden module of the other field height that matches, and says nothing when none does", () => {
    open(cabinet());
    typeQuery("vf");
    expect(screen.getByText("1 passendes Modul für 1350-mm-Felder ausgeblendet")).toBeInTheDocument();
    expect(screen.getByText("Kein Modul gefunden für „vf“.")).toBeInTheDocument();
    expect(status()).toHaveTextContent(/^Kein Treffer$/);
    typeQuery("zu62");
    expect(listedCodes()).toEqual(["ZU62A"]);
    expect(screen.queryByText(/ausgeblendet/)).toBeNull();
  });

  it("says passende Module in the plural, and keeps the plain count without a query", () => {
    open(board([], { code: "ZB52S", modules: [] }));
    expect(screen.getByText("7 Module für 1050 mm Felder ausgeblendet")).toBeInTheDocument();
    typeQuery("zaehler");
    expect(listedCodes()).toEqual(["ZH5EL27"]);
    expect(screen.getByText("4 passende Module für 1050-mm-Felder ausgeblendet")).toBeInTheDocument();
    expect(screen.queryByText("7 Module für 1050 mm Felder ausgeblendet")).toBeNull();
  });

  it("filters the managers' shelf articles on name, number and code guess, and counts them", () => {
    open(cabinet(), { catalog: shelfArticlesCatalog(), onCreateEntry: vi.fn(), onManageCatalog: vi.fn() });
    const shelfRows = () => {
      const region = screen.queryByRole("region", { name: "Im Lager, nicht im Katalog" });
      return region ? within(region).getAllByRole("listitem").map((entry) => within(entry).getByText(/^Hager /).textContent) : [];
    };
    typeQuery("feldeinbau");
    expect(shelfRows()).toEqual(["Hager ZU37X9 Feldeinbausatz"]);
    expect(listedCodes()).toEqual([]);
    expect(status()).toHaveTextContent(/^1 Treffer$/);
    typeQuery("hg55120");
    expect(shelfRows()).toEqual(["Hager Zählerplatz-Abdeckung (erfunden)"]);
    typeQuery("zx99");
    expect(shelfRows()).toEqual(["Hager Zählerplatz-Abdeckung (erfunden)"]);
    typeQuery("zu37");
    expect(shelfRows()).toEqual(["Hager ZU37X9 Feldeinbausatz"]);
    expect(status()).toHaveTextContent(/^3 Treffer$/);
    typeQuery("zh3");
    expect(shelfRows()).toEqual([]);
    // The admin stays reachable while searching.
    expect(screen.getByRole("button", { name: "Katalog verwalten" })).toBeInTheDocument();
  });

  it("searches on a read-only board too", () => {
    renderSheet(cabinet(), ({ document: current, onOp }) => (
      <ModulePickerSheet document={current} catalog={CATALOG} index={SHELF_INDEX} field={0} unit={null} readOnly onOp={onOp} onClose={vi.fn()} />
    ), SHELF_INDEX);
    expect(searchbox()).toBeEnabled();
    typeQuery("zu37");
    expect(listedCodes()).toEqual(["ZU37KS", "ZU37VT5APZ2"]);
    expect(item("ZU37KS")).toBeDisabled();
  });

  it("leaves the query to a caller that keeps it (the tab: in the stack entry)", () => {
    const onQueryChange = vi.fn();
    renderSheet(cabinet(), ({ document: current, onOp }) => (
      <ModulePickerSheet
        document={current}
        catalog={CATALOG}
        index={SHELF_INDEX}
        field={0}
        unit={null}
        readOnly={false}
        onOp={onOp}
        query="zu37"
        onQueryChange={onQueryChange}
        onClose={vi.fn()}
      />
    ), SHELF_INDEX);
    expect(searchbox()).toHaveValue("zu37");
    expect(listedCodes()).toEqual(["ZU37KS", "ZU37VT5APZ2"]);
    typeQuery("zu37k");
    expect(onQueryChange).toHaveBeenCalledWith("zu37k");
    expect(searchbox()).toHaveValue("zu37");
    fireEvent.click(screen.getByRole("button", { name: "Suche löschen" }));
    expect(onQueryChange).toHaveBeenLastCalledWith("");
  });

  it("has nothing to search without a cabinet", () => {
    open(board([]));
    expect(screen.queryByRole("searchbox")).toBeNull();
  });
});

describe("SheetFrame — toolbar slot", () => {
  it("renders the toolbar between the head and the scrolling body, and no wrapper without one", () => {
    const { container, rerender } = render(
      <SheetFrame title="Probe" onClose={vi.fn()} toolbar={<span>Werkzeug</span>}>
        <p>Inhalt</p>
      </SheetFrame>,
    );
    const toolbar = container.querySelector(".sp-encl-sheet-toolbar");
    expect(toolbar).toHaveTextContent("Werkzeug");
    expect(toolbar?.previousElementSibling).toHaveClass("sp-sheet-head");
    expect(toolbar?.nextElementSibling).toHaveClass("sp-sheet-body");
    rerender(
      <SheetFrame title="Probe" onClose={vi.fn()}>
        <p>Inhalt</p>
      </SheetFrame>,
    );
    expect(container.querySelector(".sp-encl-sheet-toolbar")).toBeNull();
  });
});

describe("modulePickerSearch — pure helpers", () => {
  const tokens = (query: string) => buildSearchTokens(query);

  it("folds a module's names, family, stock article and zone types as text; codes and numbers as identifiers", () => {
    const haystack = moduleHaystack(deepFreeze(structuredClone(MODULES.ZH3EH16)), deepFreeze({ ...ZH3EH16_ARTICLE }));
    expect(haystack.text).toEqual(expect.arrayContaining(["modul zh3eh16", "zahlerfeld ehz", "zaehlerfeld ehz", "feldbausatz musterhaus (erfunden)", "aar", "rfz", "nar"]));
    expect(haystack.ident).toEqual(expect.arrayContaining(["zh3eh16", "ws40817", "int0042", "modulzh3eh16"]));
    // Only the zone types a fitter names (NAR, AAR, RfZ, APZ, SAS, VF): not the meter place itself.
    expect(haystack.text).not.toContain("zf");
    expect(moduleHaystack(MODULES.ZU62A, null).text).not.toContain("cover");
  });

  it("folds a shelf article on its name, number and code guess", () => {
    const shelf = shelfArticlesCatalog().uncatalogued[1];
    const haystack = uncataloguedHaystack(deepFreeze(structuredClone(shelf)));
    expect(haystack.text).toEqual(expect.arrayContaining(["hager zahlerplatz-abdeckung (erfunden)", "hager zaehlerplatz-abdeckung (erfunden)"]));
    expect(haystack.ident).toEqual(expect.arrayContaining(["hg55120", "zx99b"]));
  });

  it("filters sections without touching them, in order, dropping the empty ones", () => {
    const hay = (code: string) => moduleHaystack(MODULES[code], null);
    const sections = deepFreeze([
      { key: "stock", items: [{ id: "a", haystack: hay("ZU37KS") }] },
      { key: "recent", items: [{ id: "b", haystack: hay("ZH3EL27") }] },
      { key: "catalog", items: [{ id: "c", haystack: hay("ZU37VT5APZ2") }, { id: "d", haystack: hay("ZH3EH16") }] },
    ]);
    const found = filterSections(sections, tokens("zu37"));
    expect(found.map((section) => [section.key, section.items.map((entry) => entry.id)])).toEqual([
      ["stock", ["a"]],
      ["catalog", ["c"]],
    ]);
    expect(filterSections(sections, tokens("")).map((section) => section.items.length)).toEqual([1, 1, 2]);
    expect(sections[2].items).toHaveLength(2);
  });

  it("counts hidden modules per height, lowest first, omitting heights without a match", () => {
    const hidden = deepFreeze([
      { height: 1350, haystack: moduleHaystack(MODULES.ZH5EL27, null) },
      { height: 1050, haystack: moduleHaystack(MODULES.ZU37KS, null) },
      { height: 1050, haystack: moduleHaystack(MODULES.ZH3EH16, null) },
    ]);
    expect(countHidden(hidden, tokens(""))).toEqual([{ height: 1050, count: 2 }, { height: 1350, count: 1 }]);
    expect(countHidden(hidden, tokens("zaehler"))).toEqual([{ height: 1050, count: 1 }, { height: 1350, count: 1 }]);
    expect(countHidden(hidden, tokens("zu37"))).toEqual([{ height: 1050, count: 1 }]);
    expect(countHidden(hidden, tokens("xyz"))).toEqual([]);
  });

  it("words the hints, the status and the empty state", () => {
    expect(hiddenHint({ height: 1350, count: 1 }, false)).toBe("1 Module für 1350 mm Felder ausgeblendet");
    expect(hiddenHint({ height: 1350, count: 1 }, true)).toBe("1 passendes Modul für 1350-mm-Felder ausgeblendet");
    expect(hiddenHint({ height: 1050, count: 3 }, true)).toBe("3 passende Module für 1050-mm-Felder ausgeblendet");
    expect(searchStatus(false, 12)).toBe("");
    expect(searchStatus(true, 0)).toBe("Kein Treffer");
    expect(searchStatus(true, 1)).toBe("1 Treffer");
    expect(searchStatus(true, 12)).toBe("12 Treffer");
    expect(noMatchText("  ZU 99 ")).toBe("Kein Modul gefunden für „ZU 99“.");
  });

  it("searches the whole picker at once, counting visible modules and shelf articles", () => {
    const input = deepFreeze({
      sections: [{ key: "catalog", items: [{ id: "c", haystack: moduleHaystack(MODULES.ZU37KS, null) }] }],
      hidden: [{ height: 1350, haystack: moduleHaystack(MODULES.ZH5EL27, null) }],
      shelf: shelfArticlesCatalog().uncatalogued.map((entry) => ({ item: entry, haystack: uncataloguedHaystack(entry) })),
    });
    const all = searchPicker(input, " ");
    expect(all.searching).toBe(false);
    expect(all.count).toBe(3);
    expect(all.hidden).toEqual([{ height: 1350, count: 1 }]);
    const some = searchPicker(input, "zu37");
    expect(some.searching).toBe(true);
    expect(some.count).toBe(2);
    expect(some.shelf.map((entry) => entry.item.code_guess)).toEqual(["ZU37X9"]);
    expect(some.hidden).toEqual([]);
  });
});
