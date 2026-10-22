/**
 * Groundwork for the cabinet layer (docs/PANEL_ENCLOSURE.md, Slice P).
 *
 * This release only has to KNOW what the cabinet release writes, so that a
 * rollback is an image swap: the `hlak` kind (Hauptleitungsabzweigklemme, a
 * pre-fitted part of several meter fields) and boards of up to 120 rows. It
 * must not OFFER either yet — the palette shows the HLAK only once boards can
 * have a cabinet (Slice E), and the server's twin of both constants is
 * pinned by `apps/api/tests/test_panel_enclosure_prep.py`.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { DevicePalette } from "../components/schaltplan/DevicePalette";
import { DEVICE_CATALOG, MAX_ROWS, emptyDocument, makeDevice } from "../utils/schaltplanDevices";
import { buildLegend, buildTopology } from "../utils/schaltplanTopology";
import type { PanelDevice, PanelDocument } from "../types/schaltplan";

function board(devices: PanelDevice[]): PanelDocument {
  return { ...emptyDocument(), rows: [{ id: "r1", label: "Reihe 1", slots: 40, devices }] };
}

describe("hlak", () => {
  it("is in the catalogue as the server serves it", () => {
    expect(DEVICE_CATALOG.hlak).toMatchObject({
      kind: "hlak",
      label: "Hauptleitungsabzweigklemme (HLAK)",
      short: "HLAK",
      te: 4,
      poles: 3,
      group: false,
      circuit: false,
      symbol: "terminal",
      ratingHint: "",
    });
  });

  it("neither opens a group nor counts as a circuit", () => {
    const document = board([
      makeDevice("rcd", { id: "f1", designation: "F1" }),
      makeDevice("hlak", { id: "x0", designation: "X0" }),
      makeDevice("mcb", { id: "a", designation: "F1.1", circuit: "1" }),
    ]);
    const heads = buildTopology(document)
      .filter((group) => group.device !== null)
      .map((group) => [group.device!.id, group.children.map((child) => child.id)]);
    expect(heads).toEqual([["f1", ["a"]]]);
    expect(buildLegend(document).map((row) => row.designation)).toEqual(["F1.1"]);
  });

  it("is not offered in the palette before boards can have a cabinet", () => {
    render(<DevicePalette open targetRowLabel="Reihe 1" onPick={() => undefined} onClose={() => undefined} />);
    expect(screen.getByText("Reihenklemme N/PE")).toBeInTheDocument();
    expect(screen.queryByText("Hauptleitungsabzweigklemme (HLAK)")).toBeNull();
  });
});

describe("row cap", () => {
  it("is 120, the server's MAX_ROWS", () => {
    expect(MAX_ROWS).toBe(120);
  });
});
