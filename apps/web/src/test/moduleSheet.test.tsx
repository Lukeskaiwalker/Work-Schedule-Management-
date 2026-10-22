/**
 * The module sheet (docs/PANEL_ENCLOSURE.md §10.2, §11): position and swap,
 * the pre-fitted parts ("verbaut" / "entfernt → ins Lager" / "fest
 * verbaut", with the catalogue's "ungeprüft" notes), the meter places
 * (number, label, "frei (Blindabdeckung)"), the field label, the snapshot
 * refresh on draft boards only, and "Modul entfernen" behind its confirm.
 */
import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";

import { ModuleSheet } from "../components/schaltplan/enclosure/ModuleSheet";
import { METER_LABEL_MAX, METER_NUMBER_MAX, MODULE_LABEL_MAX, placeModule } from "../utils/enclosureOps";
import { catalogFittings } from "../utils/enclosureLayout";
import { board, dev, INDEX, row } from "./enclosureTestCatalog";
import { renderSheet } from "./enclosureSheetHarness";
import type { PanelDocument } from "../types/schaltplan";

function place(document: PanelDocument, code: string, field: number, unit = 0): { document: PanelDocument; id: string } {
  const result = placeModule(document, INDEX, { code, field, unit, claim: false });
  if (!result.ok) throw new Error(result.error);
  return { document: result.document, id: result.moduleId! };
}

const cabinet = (rows = board([]).rows): PanelDocument => board(rows, { code: "ZB33S", modules: [] });

type Extra = { draft?: boolean; readOnly?: boolean; onRemoved?: () => void; onOpenRail?: (moduleId: string, railKey: string) => void };

function open(document: PanelDocument, moduleId: string, extra: Extra = {}) {
  return renderSheet(document, ({ document: current, onOp, onEdit }) => (
    <ModuleSheet
      document={current}
      index={INDEX}
      moduleId={moduleId}
      readOnly={extra.readOnly ?? false}
      draft={extra.draft ?? true}
      onOp={onOp}
      onEdit={onEdit}
      onRemoved={extra.onRemoved}
      onOpenRail={extra.onOpenRail}
      onClose={vi.fn()}
    />
  ));
}

const moduleOf = (document: PanelDocument, id: string) => document.enclosure!.modules.find((module) => module.id === id)!;
const devices = (document: PanelDocument) => document.rows.flatMap((candidate) => candidate.devices);

describe("ModuleSheet — head and position", () => {
  it("names the field and the article, and flags unverified data", () => {
    const { document, id } = place(cabinet(), "ZH3EH16", 0);
    open(document, id);
    const dialog = screen.getByRole("dialog", { name: "Feld 1 · ZH3EH16" });
    expect(within(dialog).getByText("ungeprüft")).toHaveAttribute("title", "Katalogdaten nicht vollständig geprüft");
  });

  it("moves the module and refuses what does not fit, saying why on screen", () => {
    const { document, id } = place(cabinet(), "ZU37KS", 0);
    const { current } = open(document, id);
    // A tablet shows no title tooltip and a disabled button takes no tap: the reason is text beside it.
    const position = screen.getByRole("region", { name: "Position" });
    const left = screen.getByRole("button", { name: "Feld ←" });
    expect(left).toBeDisabled();
    expect(left).toHaveAccessibleDescription("Schon im ersten Feld.");
    expect(within(position).getByText("Schon im ersten Feld.", { exact: false })).toBeVisible();
    expect(screen.getByRole("button", { name: "Nach oben" })).toHaveAccessibleDescription("Schon ganz oben.");
    expect(screen.getByRole("button", { name: "Nach unten" })).toHaveAccessibleDescription("Schon ganz unten.");
    expect(screen.getByRole("button", { name: "Nach unten" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Feld →" })).not.toHaveAccessibleDescription();
    expect(left).not.toHaveAttribute("title");
    fireEvent.click(screen.getByRole("button", { name: "Feld →" }));
    expect(moduleOf(current(), id)).toMatchObject({ field: 1, unit: 0 });
    expect(screen.getByRole("dialog", { name: "Feld 2 · ZU37KS" })).toBeInTheDocument();
  });

  it("says why a move into an occupied field and past the last field is refused", () => {
    const first = place(cabinet(), "ZU37KS", 0);
    const second = place(first.document, "ZU37VT5APZ2", 1);
    open(second.document, first.id);
    const right = screen.getByRole("button", { name: "Feld →" });
    expect(right).toBeDisabled();
    expect(right).toHaveAccessibleDescription("Nicht genug Platz: 1050 mm nötig, 0 mm frei.");
    cleanup();
    const last = place(cabinet(), "ZU37KS", 2);
    open(last.document, last.id);
    expect(screen.getByRole("button", { name: "Feld →" })).toHaveAccessibleDescription("Schon im letzten Feld.");
  });

  it("says no reasons on a read-only board, where every move is off anyway", () => {
    const { document, id } = place(cabinet(), "ZU37KS", 0);
    open(document, id, { readOnly: true });
    expect(screen.getByRole("button", { name: "Feld ←" })).not.toHaveAccessibleDescription();
    expect(screen.queryByText("Schon im ersten Feld.", { exact: false })).toBeNull();
    expect(screen.queryByText("Nur Module gleicher Größe lassen sich tauschen.")).toBeNull();
  });

  it("moves a small module up and down inside its field", () => {
    const { document, id } = place(cabinet(), "ZY150RFZ", 0, 2);
    const { current } = open(document, id);
    fireEvent.click(screen.getByRole("button", { name: "Nach oben" }));
    expect(moduleOf(current(), id).unit).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Nach unten" }));
    fireEvent.click(screen.getByRole("button", { name: "Nach unten" }));
    expect(moduleOf(current(), id).unit).toBe(3);
  });

  it("swaps with a module of the same size only", () => {
    const first = place(cabinet(), "ZU37KS", 0);
    const second = place(first.document, "ZU37VT5APZ2", 1);
    const third = place(second.document, "ZY150RFZ", 2);
    const { current } = open(third.document, first.id);
    fireEvent.click(screen.getByRole("button", { name: "Mit Modul tauschen…" }));
    expect(screen.queryByRole("button", { name: /Feld 3 · ZY150RFZ/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Feld 2 · ZU37VT5APZ2/ }));
    expect(moduleOf(current(), first.id).field).toBe(1);
    expect(moduleOf(current(), second.id).field).toBe(0);
  });

  it("offers no swap without a partner of the same size", () => {
    const { document, id } = place(cabinet(), "ZU37KS", 0);
    open(document, id);
    const swap = screen.getByRole("button", { name: "Mit Modul tauschen…" });
    expect(swap).toBeDisabled();
    expect(swap).toHaveAccessibleDescription("Nur Module gleicher Größe lassen sich tauschen.");
    expect(screen.getByText("Nur Module gleicher Größe lassen sich tauschen.")).toBeVisible();
  });
});

describe("ModuleSheet — Vorbestückt", () => {
  it("shows each part's state and the catalogue's unverified note", () => {
    const { document, id } = place(cabinet(), "ZH3EH16", 0);
    open(document, id);
    const parts = screen.getByRole("region", { name: "Vorbestückt" });
    const hs = within(parts).getByRole("listitem", { name: "Hauptschalter" });
    expect(hs).toHaveTextContent("verbaut");
    expect(hs).toHaveTextContent("ungeprüft: angenommen");
    expect(within(parts).getByRole("listitem", { name: "Sammelschiene 5-polig 12×5 mm (NAR)" })).toHaveTextContent("fest verbaut");
  });

  it("takes a part out and puts it back — once", () => {
    const { document, id } = place(cabinet(), "ZH3EH16", 0);
    const { current } = open(document, id);
    const parts = screen.getByRole("region", { name: "Vorbestückt" });
    fireEvent.click(within(parts).getByRole("button", { name: "Hauptschalter entfernen" }));
    expect(devices(current()).some((device) => device.kind === "hauptschalter")).toBe(false);
    const hs = within(parts).getByRole("listitem", { name: "Hauptschalter" });
    expect(hs).toHaveTextContent("entfernt → ins Lager");
    fireEvent.click(within(parts).getByRole("button", { name: "Hauptschalter wieder einbauen" }));
    expect(devices(current()).filter((device) => device.kind === "hauptschalter")).toHaveLength(1);
    expect(within(parts).getByRole("listitem", { name: "Hauptschalter" })).toHaveTextContent("verbaut");
  });

  it("lists a part without a device in removed_fittings", () => {
    const { document, id } = place(cabinet(), "ZU37VT5APZ2", 1);
    const { current } = open(document, id);
    fireEvent.click(screen.getByRole("button", { name: "RJ45-Buchse entfernen" }));
    expect(moduleOf(current(), id).removed_fittings).toEqual(["rj45"]);
  });

  it("offers the snapshot refresh on draft boards only, when the catalogue changed", () => {
    const placed = place(cabinet(), "ZH3EH16", 0);
    const stale: PanelDocument = {
      ...placed.document,
      enclosure: {
        ...placed.document.enclosure!,
        modules: placed.document.enclosure!.modules.map((module) => ({ ...module, fittings: [] })),
      },
    };
    const draft = open(stale, placed.id);
    fireEvent.click(screen.getByRole("button", { name: "Katalog geändert — Vorbestückung neu übernehmen" }));
    expect(moduleOf(draft.current(), placed.id).fittings).toEqual(catalogFittings("ZH3EH16", INDEX));
    expect(screen.queryByRole("button", { name: "Katalog geändert — Vorbestückung neu übernehmen" })).toBeNull();
    draft.unmount();

    open(stale, placed.id, { draft: false });
    expect(screen.queryByRole("button", { name: "Katalog geändert — Vorbestückung neu übernehmen" })).toBeNull();
  });

  it("offers no refresh when the snapshot is current", () => {
    const { document, id } = place(cabinet(), "ZH3EH16", 0);
    open(document, id);
    expect(screen.queryByRole("button", { name: /Vorbestückung neu übernehmen/ })).toBeNull();
  });
});

describe("ModuleSheet — Zählerplätze and label", () => {
  it("edits the meter number and label within the stored limits", () => {
    const { document, id } = place(cabinet(), "ZH3EL22", 0);
    const { current } = open(document, id);
    const places = screen.getByRole("region", { name: "Zählerplätze" });
    const first = within(places).getByRole("group", { name: "Zählerplatz 1" });
    const number = within(first).getByRole("textbox", { name: "Zählernummer" });
    expect(number).toHaveAttribute("maxLength", String(METER_NUMBER_MAX));
    fireEvent.change(number, { target: { value: "1EBZ0100000042" } });
    const label = within(first).getByRole("textbox", { name: "Bezeichnung (z. B. WE 1)" });
    expect(label).toHaveAttribute("maxLength", String(METER_LABEL_MAX));
    fireEvent.change(label, { target: { value: "WE 1" } });
    expect(moduleOf(current(), id).meters.find((meter) => meter.place === 0)).toEqual({ place: 0, number: "1EBZ0100000042", label: "WE 1" });
  });

  it("plans a place as reserve and back", () => {
    const { document, id } = place(cabinet(), "ZH3EL22", 0);
    const { current } = open(document, id);
    const second = within(screen.getByRole("region", { name: "Zählerplätze" })).getByRole("group", { name: "Zählerplatz 2" });
    expect(within(second).getByRole("button", { name: "belegt" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(second).getByRole("button", { name: "frei (Blindabdeckung)" }));
    expect(moduleOf(current(), id).meters.map((meter) => meter.place)).toEqual([0]);
    expect(within(second).getByRole("button", { name: "frei (Blindabdeckung)" })).toHaveAttribute("aria-pressed", "true");
    expect(within(second).queryByRole("textbox", { name: "Zählernummer" })).toBeNull();
    fireEvent.click(within(second).getByRole("button", { name: "belegt" }));
    expect(moduleOf(current(), id).meters.map((meter) => meter.place)).toEqual([0, 1]);
  });

  it("shows no meter places on a distribution field", () => {
    const { document, id } = place(cabinet(), "ZU37KS", 0);
    open(document, id);
    expect(screen.queryByRole("region", { name: "Zählerplätze" })).toBeNull();
  });

  it("names the field", () => {
    const { document, id } = place(cabinet(), "ZU37KS", 0);
    const { current } = open(document, id);
    const input = screen.getByRole("textbox", { name: "Bezeichnung des Feldes" });
    expect(input).toHaveAttribute("maxLength", String(MODULE_LABEL_MAX));
    fireEvent.change(input, { target: { value: "Wohnung oben" } });
    expect(moduleOf(current(), id).label).toBe("Wohnung oben");
  });
});

describe("ModuleSheet — rails and removal", () => {
  it("opens a rail of the module", () => {
    const { document, id } = place(cabinet(), "ZU37KS", 0);
    const onOpenRail = vi.fn();
    open(document, id, { onOpenRail });
    fireEvent.click(screen.getByRole("button", { name: /^F1 · Verteiler 3/ }));
    expect(onOpenRail).toHaveBeenCalledWith(id, "r3");
  });

  it("removes the module only after the confirm", () => {
    const placed = place(cabinet([row("own", [dev("mcb", { id: "c1" })])]), "ZH3EH16", 0);
    const onRemoved = vi.fn();
    const { current } = open(placed.document, placed.id, { onRemoved });
    fireEvent.click(screen.getByRole("button", { name: "Modul entfernen" }));
    expect(
      screen.getByText("Modul entfernen? Vorbestückte Geräte gehen mit; Reihen mit eigenen Geräten bleiben als „Nicht im Schrank“ im Plan."),
    ).toBeInTheDocument();
    expect(current().enclosure!.modules).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Ja, Modul entfernen" }));
    expect(current().enclosure!.modules).toHaveLength(0);
    expect(devices(current()).map((device) => device.id)).toEqual(["c1"]);
    expect(onRemoved).toHaveBeenCalledTimes(1);
  });

  it("is view-only read-only", () => {
    const { document, id } = place(cabinet(), "ZH3EL22", 0);
    open(document, id, { readOnly: true });
    expect(screen.getByRole("button", { name: "Feld →" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Modul entfernen" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Bezeichnung des Feldes" })).toBeDisabled();
    expect(within(screen.getByRole("group", { name: "Zählerplatz 1" })).getByRole("textbox", { name: "Zählernummer" })).toBeDisabled();
  });

  it("says so when the module is gone", () => {
    open(cabinet(), "mod-weg");
    expect(screen.getByText("Dieses Modul ist nicht mehr im Plan.")).toBeInTheDocument();
  });

  it("shows a module with an unknown code as a placeholder that can still be removed", () => {
    const document = board([], { code: "ZB33S", modules: [{ id: "mod-x", code: "ZZ99X", field: 0, unit: 0, label: "", rails: {}, fittings: null, removed_fittings: [], meters: [] }] });
    const { current } = open(document, "mod-x");
    expect(screen.getByRole("dialog", { name: "Feld 1 · ZZ99X" })).toHaveTextContent("Unbekannter Katalogcode — nur als Platzhalter gezeigt.");
    expect(screen.getByRole("button", { name: "Feld →" })).toBeDisabled();
    expect(screen.queryByRole("region", { name: "Vorbestückt" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Modul entfernen" }));
    fireEvent.click(screen.getByRole("button", { name: "Ja, Modul entfernen" }));
    expect(current().enclosure!.modules).toHaveLength(0);
  });

  it("names the meter type of a 3-Punkt field", () => {
    const { document, id } = place(cabinet(), "ZH33X7", 0);
    open(document, id);
    expect(screen.getByRole("region", { name: "Zählerplätze" })).toHaveTextContent("3-Punkt · 1 Platz");
  });
});
