/**
 * The diagram must render a group with a Vorsicherung — and show it.
 *
 * The topology tests prove the tree; this proves the SVG that draws it does
 * not throw and puts the fuse where a reader looks for it. A crash here is a
 * page crash, which is how the last Schaltplan bug reached production.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PanelDiagram } from "../components/schaltplan/PanelDiagram";
import { emptyDocument, makeDevice } from "../utils/schaltplanDevices";

describe("PanelDiagram — Vorsicherung", () => {
  it("draws the pre-fuse plate above the FI", () => {
    const document = {
      ...emptyDocument(),
      rows: [
        {
          id: "r1",
          label: "Reihe 1",
          slots: 12,
          devices: [
            makeDevice("fuse", { id: "f0", designation: "F0", rating: "35 A" }),
            makeDevice("rcd", { id: "f1", designation: "F1", parent_id: "f0" }),
            makeDevice("mcb", { id: "c1", designation: "F1.1", circuit: "1", label: "Licht" }),
          ],
        },
      ],
    };
    expect(() =>
      render(
        <PanelDiagram
          document={document}
          selectedDeviceId={null}
          onSelect={() => undefined}
          fedFrom={null}
          designation="UV"
        />,
      ),
    ).not.toThrow();
    expect(screen.getByText("F0 35 A")).toBeInTheDocument();
    // The fuse is a feeder, not a circuit column.
    expect(screen.queryByText("F0 35 A")?.closest(".sp-prefuse")).not.toBeNull();
  });
});
