/**
 * "Schrank wählen" (docs/PANEL_ENCLOSURE.md §11): cabinets grouped by
 * height, one line of facts each, a change that would drop modules or
 * switch the field height said before anyone taps it, and "Schrank
 * entfernen" behind its confirm — rows and devices stay.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";

import { EnclosurePickerSheet } from "../components/schaltplan/enclosure/EnclosurePickerSheet";
import { placeModule } from "../utils/enclosureOps";
import { catalogIndex } from "../utils/enclosureCatalog";
import { board, dev, INDEX, row, testCatalog } from "./enclosureTestCatalog";
import { renderSheet } from "./enclosureSheetHarness";
import type { PanelDocument } from "../types/schaltplan";

const CATALOG = testCatalog();

function withModuleInField(field: number): PanelDocument {
  const result = placeModule(board([], { code: "ZB33S", modules: [] }), INDEX, { code: "ZU37KS", field, unit: 0 });
  if (!result.ok) throw new Error(result.error);
  return result.document;
}

function open(document: PanelDocument, extra: { onChosen?: (code: string) => void; onClose?: () => void; readOnly?: boolean } = {}) {
  const onClose = extra.onClose ?? vi.fn();
  const harness = renderSheet(document, ({ document: current, onOp, onEdit }) => (
    <EnclosurePickerSheet
      document={current}
      catalog={CATALOG}
      index={INDEX}
      readOnly={extra.readOnly ?? false}
      onOp={onOp}
      onEdit={onEdit}
      onChosen={extra.onChosen}
      onClose={onClose}
    />
  ));
  return { ...harness, onClose };
}

describe("EnclosurePickerSheet", () => {
  it("groups the cabinets by height with the §11 item line", () => {
    open(board([row("r1", [])]));
    const dialog = screen.getByRole("dialog", { name: "Schrank wählen" });
    const groups = within(dialog).getAllByRole("heading", { level: 4 }).map((heading) => heading.textContent);
    expect(groups).toEqual(["1100 mm hoch", "1400 mm hoch"]);
    expect(within(dialog).getByRole("button", { name: /ZB33S · 3 Felder · 1100 × 800 × 205 mm · IP44 · Aufputz/ })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: /ZB52S · 2 Felder · 1400 × 550 × 205 mm · IP44 · Aufputz/ })).toBeEnabled();
    // Nothing to remove yet.
    expect(screen.queryByRole("button", { name: "Schrank entfernen" })).toBeNull();
  });

  it("sets the cabinet on a board without one", () => {
    const onChosen = vi.fn();
    const { current } = open(board([row("r1", [dev("mcb", { id: "c1" })])]), { onChosen });
    fireEvent.click(screen.getByRole("button", { name: /ZB33S · 3 Felder/ }));
    expect(current().enclosure).toEqual({ code: "ZB33S", modules: [] });
    expect(current().rows.map((candidate) => candidate.id)).toEqual(["r1"]);
    expect(onChosen).toHaveBeenCalledWith("ZB33S");
  });

  it("marks the current cabinet and says why a change cannot be made", () => {
    open(withModuleInField(2));
    expect(screen.getByRole("button", { name: /ZB33S · 3 Felder/ })).toHaveAttribute("aria-current", "true");
    const smaller = screen.getByRole("button", { name: /ZB32S · 2 Felder/ });
    expect(smaller).toBeDisabled();
    expect(smaller).toHaveTextContent("Der neue Schrank hat nur 2 Felder — erst die Module aus Feld 3 entfernen.");
    const taller = screen.getByRole("button", { name: /ZB52S · 2 Felder/ });
    expect(taller).toBeDisabled();
    expect(taller).toHaveTextContent("Höhe wechseln geht nur ohne Module — die Feldeinbausätze sind höhengebunden.");
    expect(screen.getByRole("button", { name: /ZB35S · 5 Felder/ })).toBeEnabled();
  });

  it("changes to a cabinet the modules fit into", () => {
    const { current } = open(withModuleInField(2));
    fireEvent.click(screen.getByRole("button", { name: /ZB35S · 5 Felder/ }));
    expect(current().enclosure?.code).toBe("ZB35S");
    expect(current().enclosure?.modules).toHaveLength(1);
  });

  it("removes the cabinet only after the confirm, keeping rows and devices", () => {
    const start = withModuleInField(0);
    const filled = { ...start, rows: [row("own", [dev("mcb", { id: "c1" })])] };
    const onClose = vi.fn();
    const { current } = open(filled, { onClose });
    fireEvent.click(screen.getByRole("button", { name: "Schrank entfernen" }));
    expect(screen.getByText("Schrank aus dem Plan nehmen? Reihen und Geräte bleiben erhalten.")).toBeInTheDocument();
    expect(current().enclosure).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(screen.queryByText("Schrank aus dem Plan nehmen? Reihen und Geräte bleiben erhalten.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Schrank entfernen" }));
    fireEvent.click(screen.getByRole("button", { name: "Ja, Schrank entfernen" }));
    expect(current().enclosure).toBeNull();
    expect(current().rows.map((candidate) => candidate.id)).toEqual(["own"]);
    expect(onClose).toHaveBeenCalled();
  });

  it("hides archived and invalid cabinets unless the board uses them", () => {
    const catalog = {
      ...CATALOG,
      enclosures: CATALOG.enclosures.map((entry) =>
        entry.code === "ZB35S" ? { ...entry, archived: true } : entry.code === "ZB32S" ? { ...entry, invalid: true, spec: null } : entry,
      ),
    };
    const index = catalogIndex(catalog);
    const document = board([], { code: "ZB35S", modules: [] });
    renderSheet(document, ({ document: current, onOp, onEdit }) => (
      <EnclosurePickerSheet document={current} catalog={catalog} index={index} readOnly={false} onOp={onOp} onEdit={onEdit} onClose={vi.fn()} />
    ));
    expect(screen.getByRole("button", { name: /ZB35S · 5 Felder/ })).toHaveAttribute("aria-current", "true");
    expect(screen.queryByRole("button", { name: /ZB32S/ })).toBeNull();
  });

  it("says when the catalogue has no cabinet", () => {
    const empty = { ...CATALOG, enclosures: [] };
    renderSheet(board([]), ({ document: current, onOp, onEdit }) => (
      <EnclosurePickerSheet document={current} catalog={empty} index={catalogIndex(empty)} readOnly={false} onOp={onOp} onEdit={onEdit} onClose={vi.fn()} />
    ));
    expect(screen.getByText("Der Schrankkatalog ist leer.")).toBeInTheDocument();
  });

  it("offers nothing to change read-only", () => {
    open(withModuleInField(0), { readOnly: true });
    expect(screen.getByRole("button", { name: /ZB35S · 5 Felder/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Schrank entfernen" })).toBeNull();
  });
});
