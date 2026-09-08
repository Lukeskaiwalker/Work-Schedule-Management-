/**
 * Duplicate-with-numbering and row templates.
 *
 * Both exist so an electrician stops typing "F1.4", "4", "B16", "L1" six
 * times per rail. The rules under test are the ones a wrong guess would make
 * visible on the printed BMK strip: the counted-up designation must be free,
 * the Stromkreis-Nr. must be the next unused one, and a template rail must
 * land on the same numbering a hand-built one would have reached.
 */
import { describe, expect, it } from "vitest";
import { emptyDocument, makeDevice, rowUsedSlots } from "../utils/schaltplanDevices";
import {
  ROW_TEMPLATES,
  bumpDesignation,
  duplicateDevice,
  nextDesignation,
  rowFromTemplate,
  takenDesignations,
} from "../utils/schaltplanDocumentOps";
import type { PanelDocument } from "../types/schaltplan";

function panelWithGroup(): PanelDocument {
  return {
    ...emptyDocument(),
    rows: [
      {
        id: "r1",
        label: "Reihe 1",
        slots: 12,
        devices: [
          makeDevice("rcd", { id: "fi", designation: "F1", rating: "40 A" }),
          makeDevice("mcb", {
            id: "c1",
            designation: "F1.1",
            circuit: "1",
            label: "Küche Steckdosen",
            rating: "B16",
            cable: "NYM-J 3x2,5 mm²",
            phase: "L1",
          }),
          makeDevice("mcb", { id: "c2", designation: "F1.2", circuit: "2", label: "Licht EG", rating: "B10", phase: "L2" }),
        ],
      },
    ],
  };
}

describe("bumpDesignation", () => {
  it("counts up the last number and keeps everything around it", () => {
    expect(bumpDesignation("F1.3")).toBe("F1.4");
    expect(bumpDesignation("-F3")).toBe("-F4");
    expect(bumpDesignation("F2.9")).toBe("F2.10");
    expect(bumpDesignation("Q1a")).toBe("Q2a");
  });

  it("keeps zero padding", () => {
    expect(bumpDesignation("F09")).toBe("F10");
    expect(bumpDesignation("F001")).toBe("F002");
  });

  it("cannot count a designation without a number", () => {
    expect(bumpDesignation("HS")).toBe("HS");
  });
});

describe("nextDesignation", () => {
  it("skips designations that are already in use, however they were typed", () => {
    const board = panelWithGroup();
    const document = {
      ...board,
      rows: [
        {
          ...board.rows[0],
          devices: [
            ...board.rows[0].devices,
            makeDevice("mcb", { id: "c3", designation: "f1.3", circuit: "3" }),
            makeDevice("mcb", { id: "c4", designation: "F1.4", circuit: "4" }),
          ],
        },
      ],
    };
    expect(nextDesignation("F1.2", takenDesignations(document))).toBe("F1.5");
  });

  it("gives up on an unnumbered or empty seed instead of duplicating it", () => {
    expect(nextDesignation("", new Set())).toBe("");
    expect(nextDesignation("HS", new Set(["HS"]))).toBe("");
  });
});

describe("duplicateDevice", () => {
  it("puts the copy right after the original with the next free BMK and Stromkreis-Nr.", () => {
    const { document, deviceId } = duplicateDevice(panelWithGroup(), "c1");
    const devices = document.rows[0].devices;
    expect(deviceId).not.toBeNull();
    expect(devices.map((d) => d.id)).toEqual(["fi", "c1", deviceId, "c2"]);
    const copy = devices[2];
    // F1.2 is taken by c2, so the count-up must land on F1.3.
    expect(copy.designation).toBe("F1.3");
    expect(copy.circuit).toBe("3");
    expect(copy.id).not.toBe("c1");
  });

  it("copies the electrical data verbatim — that is what 'copy' means", () => {
    const { document } = duplicateDevice(panelWithGroup(), "c1");
    const copy = document.rows[0].devices[2];
    expect(copy.kind).toBe("mcb");
    expect(copy.rating).toBe("B16");
    expect(copy.cable).toBe("NYM-J 3x2,5 mm²");
    expect(copy.phase).toBe("L1");
    expect(copy.label).toBe("Küche Steckdosen");
  });

  it("does not number a device that has no Stromkreis line", () => {
    const { document } = duplicateDevice(panelWithGroup(), "fi");
    const copy = document.rows[0].devices[1];
    expect(copy.kind).toBe("rcd");
    expect(copy.designation).toBe("F2");
    expect(copy.circuit).toBe("");
  });

  it("leaves the document alone for an unknown id", () => {
    const source = panelWithGroup();
    const { document, deviceId } = duplicateDevice(source, "nope");
    expect(deviceId).toBeNull();
    expect(document).toBe(source);
  });

  it("never mutates the input", () => {
    const source = panelWithGroup();
    const before = JSON.stringify(source);
    duplicateDevice(source, "c1");
    expect(JSON.stringify(source)).toBe(before);
  });
});

describe("takenDesignations", () => {
  it("collects every non-empty BMK upper-cased", () => {
    expect([...takenDesignations(panelWithGroup())].sort()).toEqual(["F1", "F1.1", "F1.2"]);
  });
});

describe("rowFromTemplate", () => {
  it("builds FI + 6 LS with group numbering, sequential circuits and rotating phases", () => {
    const row = rowFromTemplate(panelWithGroup(), "rcd-6mcb");
    expect(row.label).toBe("Reihe 2");
    expect(row.devices.map((d) => d.kind)).toEqual(["rcd", "mcb", "mcb", "mcb", "mcb", "mcb", "mcb"]);
    const [fi, ...breakers] = row.devices;
    // F1 exists on the board, so this group becomes F2 and its breakers F2.x.
    expect(fi.designation).toBe("F2");
    expect(fi.rating).toBe("40 A");
    expect(fi.residual_current).toBe("30 mA");
    expect(fi.phase).toBe("L1-L3");
    expect(breakers.map((d) => d.designation)).toEqual(["F2.1", "F2.2", "F2.3", "F2.4", "F2.5", "F2.6"]);
    expect(breakers.map((d) => d.circuit)).toEqual(["3", "4", "5", "6", "7", "8"]);
    expect(breakers.map((d) => d.phase)).toEqual(["L1", "L2", "L3", "L1", "L2", "L3"]);
    expect(breakers.every((d) => d.rating === "B16")).toBe(true);
    expect(row.slots).toBe(12);
    expect(rowUsedSlots(row)).toBe(10);
  });

  it("continues the previous rail's numbering when the template has no FI", () => {
    const row = rowFromTemplate(panelWithGroup(), "mcb-12");
    expect(row.devices).toHaveLength(12);
    expect(row.devices[0].designation).toBe("F1.3");
    expect(row.devices[11].designation).toBe("F1.14");
    expect(row.devices[0].circuit).toBe("3");
    expect(row.devices[11].circuit).toBe("14");
    expect(row.slots).toBe(12);
  });

  it("hangs a bare LS rail under an FI that has no breakers yet", () => {
    // Add the FI, then straight away "Reihe aus Vorlage" → 12 LS: the
    // breakers belong to F1, they are not new top-level groups F2…F13.
    const board = emptyDocument();
    const document = {
      ...board,
      rows: [{ ...board.rows[0], devices: [makeDevice("rcd", { id: "fi", designation: "F1" })] }],
    };
    const row = rowFromTemplate(document, "mcb-12");
    expect(row.devices[0].designation).toBe("F1.1");
    expect(row.devices[11].designation).toBe("F1.12");
  });

  it("continues under the FI placed last, not the breakers before it", () => {
    const board = panelWithGroup();
    const document = {
      ...board,
      rows: [
        ...board.rows,
        { id: "r2", label: "Reihe 2", slots: 12, devices: [makeDevice("rcd", { id: "fi2", designation: "F2" })] },
      ],
    };
    const row = rowFromTemplate(document, "mcb-12");
    expect(row.devices[0].designation).toBe("F2.1");
  });

  it("starts at F1 under a group that is not F-numbered", () => {
    const board = emptyDocument();
    const document = {
      ...board,
      rows: [{ ...board.rows[0], devices: [makeDevice("hauptschalter", { id: "hs", designation: "Q1" })] }],
    };
    const row = rowFromTemplate(document, "mcb-12");
    expect(row.devices[0].designation).toBe("F1");
    expect(row.devices[1].designation).toBe("F2");
  });

  it("starts at F1 on an empty board", () => {
    const row = rowFromTemplate(emptyDocument(), "rcd-8mcb");
    expect(row.devices[0].designation).toBe("F1");
    expect(row.devices[1].designation).toBe("F1.1");
    expect(row.devices[1].circuit).toBe("1");
    expect(row.devices).toHaveLength(9);
    expect(rowUsedSlots(row)).toBe(12);
  });

  it("widens the rail when a template would overflow the default 12 TE", () => {
    const row = rowFromTemplate(emptyDocument(), "rcd-6mcb", { slots: 8 });
    expect(row.slots).toBe(10);
  });

  it("gives every device its own id", () => {
    const row = rowFromTemplate(emptyDocument(), "rcd-8mcb");
    expect(new Set(row.devices.map((d) => d.id)).size).toBe(row.devices.length);
  });

  it("returns an empty rail for the empty template and for unknown ids", () => {
    expect(rowFromTemplate(emptyDocument(), "empty").devices).toEqual([]);
    expect(rowFromTemplate(emptyDocument(), "does-not-exist").devices).toEqual([]);
  });

  it("offers the rails the user asked for", () => {
    expect(ROW_TEMPLATES.map((t) => t.id)).toEqual(["empty", "rcd-6mcb", "rcd-8mcb", "mcb-12"]);
  });
});
