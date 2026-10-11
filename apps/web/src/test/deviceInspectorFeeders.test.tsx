/**
 * "Eingespeist von" for an FI, Hauptschalter, SLS or Verteilerblock.
 *
 * Owner, 2026-10-09: "I can not assign an SLS to an RCD … an SLS to a
 * Hauptschalter and then a Hauptschalter to an FI". What must hold: a group
 * device offers every fuse (as Vorsicherung) and every SLS, Hauptschalter
 * and Verteilerblock as its feed — never itself and never a device it
 * already feeds, directly or further down, so the picker cannot build a
 * circle; picking one writes `parent_id`.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { DeviceInspector } from "../components/schaltplan/DeviceInspector";
import { emptyDocument, makeDevice } from "../utils/schaltplanDevices";
import type { PanelDevice, PanelDocument } from "../types/schaltplan";

function chain(): PanelDocument {
  return {
    ...emptyDocument(),
    rows: [
      {
        id: "r1",
        label: "Reihe 1",
        slots: 30,
        devices: [
          makeDevice("fuse", { id: "n0", designation: "F0", rating: "35 A" }),
          makeDevice("sls", { id: "q0", designation: "Q0", rating: "E35" }),
          makeDevice("hauptschalter", { id: "q1", designation: "Q1", rating: "63 A", parent_id: "q0" }),
          makeDevice("distribution_block", { id: "x1", designation: "X1", parent_id: "q1" }),
          makeDevice("rcd", { id: "f1", designation: "F1", parent_id: "x1" }),
          makeDevice("mcb", { id: "c1", designation: "F1.1", circuit: "1" }),
        ],
      },
    ],
  };
}

function open(id: string) {
  const document = chain();
  const device = document.rows[0].devices.find((entry) => entry.id === id) as PanelDevice;
  const onChange = vi.fn();
  render(
    <DeviceInspector
      device={device}
      document={document}
      readOnly={false}
      onChange={onChange}
      onDelete={() => undefined}
      onDuplicate={() => undefined}
      onMove={() => undefined}
      onClose={() => undefined}
    />,
  );
  const select = screen.getByLabelText("Eingespeist von") as HTMLSelectElement;
  const labels = within(select).getAllByRole("option").map((option) => option.textContent);
  return { select, labels, onChange };
}

describe("DeviceInspector — Eingespeist von for group devices", () => {
  it("offers an FI every fuse and every SLS, Hauptschalter and Verteilerblock", () => {
    const { labels } = open("f1");
    expect(labels).toEqual([
      "Keine (direkt von der Sammelschiene)",
      "Si F0 35 A — Vorsicherung",
      "Q0 SLS E35",
      "Q1 HS 63 A",
      "X1 VB",
    ]);
  });

  it("never offers a device itself or anything it already feeds", () => {
    const { labels } = open("q1");
    expect(labels).toEqual(["Keine (direkt von der Sammelschiene)", "Si F0 35 A — Vorsicherung", "Q0 SLS E35"]);
  });

  it("writes the pick as the device's parent", () => {
    const { select, onChange } = open("f1");
    fireEvent.change(select, { target: { value: "q0" } });
    expect(onChange).toHaveBeenCalledWith({ parent_id: "q0" });
  });
});
