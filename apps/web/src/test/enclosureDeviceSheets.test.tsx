/**
 * The device sheets on a board with a cabinet (docs/PANEL_ENCLOSURE.md D7,
 * D13, §11):
 *
 *  - the inspector of a pre-fitted part says so — deleting it means taking
 *    it out of the module, and it then comes back as an "ins Lager" line —
 *    and quotes what the catalogue has not checked about it;
 *  - "Auf andere Hutschiene…" is offered where the caller has a cabinet;
 *  - the palette offers the HLAK only on cabinet boards, and names a DIN
 *    rail meter there "Zwischenzähler (Hutschiene)" — the eHZ goes onto the
 *    meter place;
 *  - inside the Schrank tab's sheet stack both render without a backdrop
 *    of their own (the stack has exactly one).
 *
 * Invented boards only — the repo is public.
 */
import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { DeviceInspector } from "../components/schaltplan/DeviceInspector";
import { DevicePalette } from "../components/schaltplan/DevicePalette";
import { emptyDocument, makeDevice } from "../utils/schaltplanDevices";
import type { PanelDevice, PanelDocument } from "../types/schaltplan";

const CABINET: PanelDocument = { ...emptyDocument({ enclosureCode: "ZB33S" }) };
const PLAIN: PanelDocument = emptyDocument();

function renderInspector(device: PanelDevice, document: PanelDocument, extra: Partial<Parameters<typeof DeviceInspector>[0]> = {}) {
  const props = {
    device,
    document: { ...document, rows: [{ id: "r1", label: "Reihe 1", slots: 12, devices: [device] }] },
    readOnly: false,
    onChange: vi.fn(),
    onDelete: vi.fn(),
    onDuplicate: vi.fn(),
    onMove: vi.fn(),
    onClose: vi.fn(),
    ...extra,
  };
  render(<DeviceInspector {...props} />);
  return props;
}

describe("DeviceInspector on a cabinet board", () => {
  it("says a part is pre-fitted, what deleting it means, and what is unchecked", () => {
    const hs = makeDevice("hauptschalter", { id: "q1", designation: "Q1", supplied_by: { module: "m1", part: "hs" } });
    renderInspector(hs, CABINET, { suppliedBy: { article: "ZH3EH16", unverifiedNote: "Typ angenommen" } });
    expect(screen.getByText("Vorbestückt in ZH3EH16")).toBeInTheDocument();
    expect(
      screen.getByText("— Löschen heißt: aus dem Modul entfernen; es kommt als „ins Lager“ auf die Materialliste.", { exact: false }),
    ).toBeInTheDocument();
    expect(screen.getByText("Katalog ungeprüft: Typ angenommen")).toBeInTheDocument();
  });

  it("shows no banner for an ordinary device", () => {
    renderInspector(makeDevice("mcb", { id: "a" }), CABINET, { suppliedBy: null });
    expect(screen.queryByText(/^Vorbestückt in/)).toBeNull();
  });

  it("offers 'Auf andere Hutschiene…' when the caller can move it, and not read-only", () => {
    const onMoveToRail = vi.fn();
    renderInspector(makeDevice("mcb", { id: "a" }), CABINET, { onMoveToRail });
    fireEvent.click(screen.getByRole("button", { name: "Auf andere Hutschiene…" }));
    expect(onMoveToRail).toHaveBeenCalledTimes(1);
  });

  it("offers no move without a handler", () => {
    renderInspector(makeDevice("mcb", { id: "a" }), PLAIN);
    expect(screen.queryByRole("button", { name: "Auf andere Hutschiene…" })).toBeNull();
  });

  it("names a rail meter Zwischenzähler on a cabinet board only", () => {
    renderInspector(makeDevice("meter", { id: "p1" }), CABINET);
    expect(screen.getByRole("dialog", { name: "Zwischenzähler (Hutschiene)" })).toBeInTheDocument();
  });

  it("keeps the old name without a cabinet", () => {
    renderInspector(makeDevice("meter", { id: "p1" }), PLAIN);
    expect(screen.getByRole("dialog", { name: "Zähler / eHZ" })).toBeInTheDocument();
  });

  it("renders without its own backdrop inside a sheet stack", () => {
    renderInspector(makeDevice("mcb", { id: "a" }), CABINET, { embedded: true });
    expect(screen.getByRole("dialog", { name: "Leitungsschutzschalter" })).toBeInTheDocument();
    expect(document.querySelectorAll(".sp-sheet-backdrop")).toHaveLength(0);
  });

  it("takes the stack's glove-sized targets inside it, and keeps its own size on the Plan tab", () => {
    renderInspector(makeDevice("mcb", { id: "a" }), CABINET, { embedded: true });
    expect(screen.getByRole("dialog", { name: "Leitungsschutzschalter" })).toHaveClass("sp-sheet--glove");
    cleanup();
    renderInspector(makeDevice("mcb", { id: "b" }), CABINET);
    expect(screen.getByRole("dialog", { name: "Leitungsschutzschalter" })).not.toHaveClass("sp-sheet--glove");
  });
});

describe("DevicePalette on a cabinet board", () => {
  const open = (document: PanelDocument | undefined, embedded = false) =>
    render(<DevicePalette open targetRowLabel="F1 · AAR 2" document={document} embedded={embedded} onPick={vi.fn()} onClose={vi.fn()} />);

  it("offers the HLAK and the Zwischenzähler", () => {
    open(CABINET);
    expect(screen.getByText("Hauptleitungsabzweigklemme (HLAK)")).toBeInTheDocument();
    expect(screen.getByText("Zwischenzähler (Hutschiene)")).toBeInTheDocument();
    expect(screen.queryByText("Zähler / eHZ")).toBeNull();
  });

  it("offers neither on a board without a cabinet", () => {
    open(PLAIN);
    expect(screen.queryByText("Hauptleitungsabzweigklemme (HLAK)")).toBeNull();
    expect(screen.getByText("Zähler / eHZ")).toBeInTheDocument();
  });

  it("renders without a backdrop inside the stack", () => {
    open(CABINET, true);
    expect(screen.getByRole("dialog", { name: "Gerät hinzufügen" })).toBeInTheDocument();
    expect(document.querySelectorAll(".sp-sheet-backdrop")).toHaveLength(0);
    expect(screen.getByRole("dialog", { name: "Gerät hinzufügen" })).toHaveClass("sp-sheet--glove");
  });

  it("keeps its own size outside the stack", () => {
    open(CABINET);
    expect(screen.getByRole("dialog", { name: "Gerät hinzufügen" })).not.toHaveClass("sp-sheet--glove");
  });
});
