/**
 * "Auf andere Hutschiene…" (docs/PANEL_ENCLOSURE.md §10.2, §11): every rail
 * of the cabinet as "Feld {n} · {zone} · {free} PLE frei", the device's own
 * rail left out, retired rails left out, and the device moved — pre-fitted
 * part or not — with its feed kept.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";

import { RailPickerSheet } from "../components/schaltplan/enclosure/RailPickerSheet";
import { catalogIndex } from "../utils/enclosureCatalog";
import { linkedRows } from "../utils/enclosureLayout";
import { addDeviceToRail, fillRailFromTemplate, placeModule } from "../utils/enclosureOps";
import { board, dev, INDEX, MODULES, row, testCatalog } from "./enclosureTestCatalog";
import { renderSheet } from "./enclosureSheetHarness";
import type { CatalogIndex } from "../utils/enclosureCatalog";
import type { PanelDocument } from "../types/schaltplan";

function place(document: PanelDocument, code: string, field: number, index: CatalogIndex = INDEX) {
  const result = placeModule(document, index, { code, field, unit: 0, claim: false });
  if (!result.ok) throw new Error(result.error);
  return { document: result.document, id: result.moduleId! };
}

function open(document: PanelDocument, deviceId: string, extra: { onMoved?: () => void; index?: CatalogIndex } = {}) {
  const index = extra.index ?? INDEX;
  return renderSheet(
    document,
    ({ document: current, onOp }) => (
      <RailPickerSheet
        document={current}
        index={index}
        deviceId={deviceId}
        readOnly={false}
        onOp={onOp}
        onMoved={extra.onMoved}
        onClose={vi.fn()}
      />
    ),
    index,
  );
}

function boardWithSls() {
  const outside = board([row("alt", [dev("sls", { id: "q0", designation: "Q0", rating: "E35" })], "Altbestand")], {
    code: "ZB33S",
    modules: [],
  });
  const meter = place(outside, "ZH3EH16", 0);
  const dist = place(meter.document, "ZU37KS", 1);
  const filled = fillRailFromTemplate(dist.document, INDEX, dist.id, "r1", "rcd-6mcb");
  if (!filled.ok) throw new Error(filled.error);
  return { document: filled.document, meterId: meter.id, distId: dist.id };
}

describe("RailPickerSheet", () => {
  it("lists every rail with its free space", () => {
    const { document } = boardWithSls();
    open(document, "q0");
    const dialog = screen.getByRole("dialog", { name: "Hutschiene wählen" });
    expect(dialog).toHaveTextContent("Q0");
    const items = within(dialog).getAllByRole("button", { name: /PLE frei/ }).map((button) => button.getAttribute("aria-label"));
    expect(items).toContain("Feld 1 · NAR · 12 PLE frei");
    expect(items).toContain("Feld 1 · AAR 1 · 9 PLE frei");
    expect(items).toContain("Feld 1 · RfZ · 12 PLE frei");
    expect(items).toContain("Feld 2 · Verteiler 1 · 2 PLE frei");
    expect(items).toContain("Feld 2 · Verteiler 7 · 12 PLE frei");
    // ZH3EH16 (3 + 1 + 1 rails, zf has none) + ZU37KS (7).
    expect(items).toHaveLength(4 + 7);
  });

  it("moves the device and leaves its own rail out of the list", () => {
    const { document, meterId } = boardWithSls();
    const onMoved = vi.fn();
    const { current } = open(document, "q0", { onMoved });
    fireEvent.click(screen.getByRole("button", { name: "Feld 1 · NAR · 12 PLE frei" }));
    expect(linkedRows(current(), INDEX).get(current().rows.find((candidate) => candidate.devices.some((d) => d.id === "q0"))!.id)).toEqual({
      moduleId: meterId,
      railKey: "nar",
    });
    expect(onMoved).toHaveBeenCalledWith({ moduleId: meterId, railKey: "nar" });
    expect(screen.queryByRole("button", { name: /^Feld 1 · NAR/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Feld 1 · AAR 1/ })).toBeInTheDocument();
  });

  it("counts the busbar SLS width in PLE", () => {
    const { document, meterId } = boardWithSls();
    const onNar = addDeviceToRail(document, INDEX, meterId, "nar", "sls");
    if (!onNar.ok) throw new Error(onNar.error);
    open(onNar.document, "q0");
    expect(screen.getByRole("button", { name: "Feld 1 · NAR · 7,5 PLE frei" })).toBeInTheDocument();
  });

  it("still offers a rail too full for the device, marked", () => {
    const { document } = boardWithSls();
    open(document, "q0");
    const tight = screen.getByRole("button", { name: "Feld 2 · Verteiler 1 · 2 PLE frei" });
    expect(tight).toBeEnabled();
    // Said on the item, not in a tooltip a tablet never shows.
    expect(tight).toHaveAccessibleDescription("Zu wenig Platz — die Hutschiene läuft über.");
    expect(within(tight).getByText("Zu wenig Platz — die Hutschiene läuft über.")).toBeVisible();
    expect(tight).not.toHaveAttribute("title");
    const roomy = screen.getByRole("button", { name: "Feld 1 · NAR · 12 PLE frei" });
    expect(roomy).not.toHaveAccessibleDescription();
    expect(roomy).toHaveTextContent("Feld 1 · NAR · 12 PLE frei");
  });

  it("has nowhere to go on a board without modules", () => {
    open(board([row("alt", [dev("mcb", { id: "c1" })])], { code: "ZB33S", modules: [] }), "c1");
    expect(screen.getByText("Im Schrank gibt es keine andere Hutschiene.")).toBeInTheDocument();
  });

  it("leaves retired rails out", () => {
    const retired = { ...MODULES.ZU37KS, zones: MODULES.ZU37KS.zones.map((zone) => ({ ...zone, rails: zone.rails.map((rail) => (rail.key === "r7" ? { ...rail, retired: true } : rail)) })) };
    const index = catalogIndex(testCatalog({ modules: { ZU37KS: retired } }));
    const start = board([row("alt", [dev("mcb", { id: "c1" })])], { code: "ZB33S", modules: [] });
    const { document } = place(start, "ZU37KS", 1, index);
    open(document, "c1", { index });
    expect(screen.queryByRole("button", { name: /Verteiler 7/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Verteiler 6/ })).toBeInTheDocument();
  });

  it("says so when the device is gone", () => {
    const { document } = boardWithSls();
    open(document, "weg");
    expect(screen.getByText("Dieses Gerät ist nicht mehr im Plan.")).toBeInTheDocument();
  });
});
