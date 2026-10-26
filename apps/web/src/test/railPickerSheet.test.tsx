/**
 * "Auf andere Hutschiene…" (docs/PANEL_ENCLOSURE.md §10.2, §11; round 2:
 * docs/PANEL_ENCLOSURE_R2.md §6.8): every rail of the cabinet as "Feld {n}
 * · {zone} · {free} PLE frei", the device's own rail and retired rails left
 * out, terminal rails listed but disabled — then, on a rail that holds
 * devices, **Wohin auf {title}?** with Am Anfang · Nach {bmk} · Am Ende.
 * The pick is handed to `onDrop` (the tab runs `dropDevice` through the
 * drop note, so the picker follows position exactly like a drag).
 */
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";

import { RailPickerSheet } from "../components/schaltplan/enclosure/RailPickerSheet";
import { catalogIndex } from "../utils/enclosureCatalog";
import { linkedRows } from "../utils/enclosureLayout";
import { addDeviceToRail, fillRailFromTemplate, placeModule } from "../utils/enclosureOps";
import { dropDevice, type DropTarget } from "../utils/enclosureOpsDrag";
import { board, dev, INDEX, MODULES, row, testCatalog } from "./enclosureTestCatalog";
import { renderSheet } from "./enclosureSheetHarness";
import type { CatalogIndex } from "../utils/enclosureCatalog";
import type { PanelDocument } from "../types/schaltplan";

function place(document: PanelDocument, code: string, field: number, index: CatalogIndex = INDEX) {
  const result = placeModule(document, index, { code, field, unit: 0, claim: false });
  if (!result.ok) throw new Error(result.error);
  return { document: result.document, id: result.moduleId! };
}

type Extra = { index?: CatalogIndex; reserved?: ReadonlySet<string>; setBackHandler?: (handler: (() => void) | null) => void };

function open(document: PanelDocument, deviceId: string, extra: Extra = {}) {
  const index = extra.index ?? INDEX;
  const drops: DropTarget[] = [];
  const harness = renderSheet(
    document,
    ({ document: current, onEdit }) => (
      <RailPickerSheet
        document={current}
        index={index}
        deviceId={deviceId}
        readOnly={false}
        reserved={extra.reserved}
        setBackHandler={extra.setBackHandler}
        onDrop={(target) => {
          drops.push(target);
          onEdit((doc) => {
            const result = dropDevice(doc, index, deviceId, target);
            return result.ok ? result.document : doc;
          });
        }}
        onClose={vi.fn()}
      />
    ),
    index,
  );
  return { ...harness, drops };
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

const rowHolding = (document: PanelDocument, deviceId: string) => document.rows.find((candidate) => candidate.devices.some((d) => d.id === deviceId))!;

describe("RailPickerSheet — the rails", () => {
  it("lists every rail with its free space", () => {
    const { document } = boardWithSls();
    open(document, "q0");
    const dialog = screen.getByRole("dialog", { name: "Hutschiene wählen" });
    expect(dialog).toHaveTextContent("Q0");
    const items = within(dialog).getAllByRole("button", { name: /PLE frei/ }).map((button) => button.getAttribute("aria-label"));
    expect(items).toContain("Feld 1 · NAR · 12 PLE frei");
    // The Hauptschalter (3 TE) and the §14a block placeModule seeded (44,2 mm, R4-2): (210 − 52,5 − 44,2) / 17,5.
    expect(items).toContain("Feld 1 · AAR 1 · 6,5 PLE frei");
    expect(items).toContain("Feld 1 · RfZ · 12 PLE frei");
    expect(items).toContain("Feld 2 · Verteiler 1 · 2 PLE frei");
    expect(items).toContain("Feld 2 · Verteiler 7 · 12 PLE frei");
    // ZH3EH16 (3 + 1 + 1 rails, zf has none) + ZU37KS (7).
    expect(items).toHaveLength(4 + 7);
  });

  it("drops onto an empty rail at once, and leaves its own rail out afterwards", () => {
    const { document, meterId } = boardWithSls();
    const { current, drops } = open(document, "q0");
    fireEvent.click(screen.getByRole("button", { name: "Feld 1 · NAR · 12 PLE frei" }));
    expect(drops).toEqual([{ moduleId: meterId, railKey: "nar", at: 0 }]);
    expect(linkedRows(current(), INDEX).get(rowHolding(current(), "q0").id)).toEqual({ moduleId: meterId, railKey: "nar" });
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

  it("lists a terminal rail disabled, and says why", () => {
    const { document, distId } = boardWithSls();
    open(document, "q0", { reserved: new Set([`${distId}:r2`]) });
    const reserved = screen.getByRole("button", { name: "Feld 2 · Verteiler 2 · 12 PLE frei" });
    expect(reserved).toBeDisabled();
    expect(reserved).toHaveAccessibleDescription("für Reihenklemmen reserviert");
    expect(screen.getByRole("button", { name: "Feld 2 · Verteiler 3 · 12 PLE frei" })).toBeEnabled();
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

describe("RailPickerSheet — the position step (Wohin auf …?)", () => {
  it("asks where on a rail that holds devices: Am Anfang, after each device, Am Ende", () => {
    const { document, distId } = boardWithSls();
    const { current, drops } = open(document, "q0");
    fireEvent.click(screen.getByRole("button", { name: "Feld 2 · Verteiler 1 · 2 PLE frei" }));
    const step = screen.getByRole("dialog", { name: "Wohin auf F2 · Verteiler 1?" });
    const choices = within(step).getAllByRole("button").map((button) => button.textContent);
    expect(choices).toEqual(expect.arrayContaining(["Am Anfang", "Nach F1", "Nach F1.1", "Nach F1.6", "Am Ende"]));
    expect(drops).toEqual([]);

    fireEvent.click(within(step).getByRole("button", { name: "Nach F1.2" }));
    expect(drops).toEqual([{ moduleId: distId, railKey: "r1", at: 3 }]);
    expect(rowHolding(current(), "q0").devices.map((d) => d.designation)).toEqual(["F1", "F1.1", "F1.2", "Q0", "F1.3", "F1.4", "F1.5", "F1.6"]);
  });

  it("Am Anfang and Am Ende", () => {
    const { document, distId } = boardWithSls();
    const first = open(document, "q0");
    fireEvent.click(screen.getByRole("button", { name: "Feld 2 · Verteiler 1 · 2 PLE frei" }));
    fireEvent.click(screen.getByRole("button", { name: "Am Anfang" }));
    expect(first.drops).toEqual([{ moduleId: distId, railKey: "r1", at: 0 }]);
    first.unmount();

    const last = open(document, "q0");
    fireEvent.click(screen.getByRole("button", { name: "Feld 2 · Verteiler 1 · 2 PLE frei" }));
    fireEvent.click(screen.getByRole("button", { name: "Am Ende" }));
    expect(last.drops).toEqual([{ moduleId: distId, railKey: "r1", at: 7 }]);
  });

  it("‹ and the stack's back step (Escape, backdrop) return to the rail list", () => {
    const { document } = boardWithSls();
    let handler: (() => void) | null = null;
    const setBackHandler = vi.fn((next: (() => void) | null) => {
      handler = next;
    });
    open(document, "q0", { setBackHandler });
    fireEvent.click(screen.getByRole("button", { name: "Feld 2 · Verteiler 1 · 2 PLE frei" }));
    expect(handler).toBeTypeOf("function");
    fireEvent.click(screen.getByRole("button", { name: "Zurück" }));
    expect(screen.getByRole("dialog", { name: "Hutschiene wählen" })).toBeInTheDocument();
    expect(handler).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Feld 2 · Verteiler 1 · 2 PLE frei" }));
    // Escape and the backdrop call the handler the sheet set.
    act(() => (handler as unknown as () => void)());
    expect(screen.getByRole("dialog", { name: "Hutschiene wählen" })).toBeInTheDocument();
  });

  it("a group head goes with its circuits, which are no 'Nach' choices of their own", () => {
    const outside = board(
      [
        row("alt", [dev("rcd", { id: "fi9", designation: "F9" }), dev("mcb", { id: "l91", designation: "F9.1" }), dev("mcb", { id: "l92", designation: "F9.2" })], "Altbestand"),
      ],
      { code: "ZB33S", modules: [] },
    );
    const dist = place(outside, "ZU37KS", 1);
    const { current } = open(dist.document, "fi9");
    expect(screen.getByRole("dialog", { name: "Hutschiene wählen" })).toHaveTextContent("mit 2 Stromkreisen");
    fireEvent.click(screen.getByRole("button", { name: "Feld 2 · Verteiler 3 · 12 PLE frei" }));
    expect(rowHolding(current(), "fi9").devices.map((d) => d.id)).toEqual(["fi9", "l91", "l92"]);
  });
});
