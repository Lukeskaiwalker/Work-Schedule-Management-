/**
 * The §14a block on the printer, screen side (docs/PANEL_ENCLOSURE_R4.md
 * §9.1–§9.2): the strip's one size and the "fits" rule are twins of
 * `werkstatt_label_control_strip.py`, pinned on the shared fixture table
 * `control_strip_size`; the hand-written expectations below were computed
 * with the Python module (budget 105,92 dots, fits from 24 dots up).
 *
 * The predicates read the block only through `parseControlBlock`, so a
 * stored block a tablet half-wrote prints what the server prints.
 */
import { describe, expect, it } from "vitest";

import { FIXTURE_TABLES, boardDocument } from "./enclosureFixtureBoards";
import { deepFreeze } from "./enclosureTestCatalog";
import { CONTROL_PARTS, PART_TERMINAL, WIRE_LABEL_PIECE_MM, defaultControlBlock } from "../utils/enclosureControlBlock";
import {
  CONTROL_SEGMENT_MM,
  CONTROL_STRIP_CAP_DOTS,
  CONTROL_STRIP_MAX_DOTS,
  controlLabelFits,
  controlStripBudgetDots,
  controlStripSize,
} from "../utils/schaltplanStrip";
import {
  CONTROL_STALE_DETAIL,
  CONTROL_STRIP_ID,
  CONTROL_STRIP_TITLE,
  NO_WIRE_LABELS_DETAIL,
  WIRE_STRIP_ID,
  controlStrip,
  klemmenStripIds,
  labelTooLongDetail,
  tubeMaterial,
  wireLabelSegments,
  wireLabelSize,
} from "../utils/schaltplanControlStrip";
import type { ControlBlock } from "../types/panelEnclosure";
import type { PanelDocument } from "../types/schaltplan";

function boardWith(block: unknown): PanelDocument {
  return { version: 1, rows: [], enclosure: { code: "ZB33S", modules: [], control_block: block } } as unknown as PanelDocument;
}

function blockWith(labels: string[], overrides: Partial<ControlBlock> = {}): ControlBlock {
  return {
    ...defaultControlBlock(),
    terminals: labels.map((label, i) => ({ id: `t${i + 1}`, label, color: "braun" })),
    ...overrides,
  };
}

describe("controlStripSize ⇄ control_strip_size", () => {
  it("agrees with every row of the shared fixture table", () => {
    const table = FIXTURE_TABLES.control_strip_size ?? [];
    // The table must be there: without it this test would pass on nothing.
    expect(table.length).toBeGreaterThanOrEqual(4);
    for (const row of table) {
      expect(controlStripSize(row.labels)).toBe(row.size);
    }
  });

  it("gives the default block 35 dots and an all-blank strip the 48-dot ceiling", () => {
    expect(controlStripSize(defaultControlBlock().terminals.map((t) => t.label))).toBe(35);
    expect(controlStripSize(["", ""])).toBe(CONTROL_STRIP_MAX_DOTS);
    expect(controlStripSize([])).toBe(48);
    // Room enough for 73 dots, still capped at 48.
    expect(controlStripSize(["0%"])).toBe(48);
    // A long label drags the size below the minimum: the size says so, the fit rule refuses it.
    expect(controlStripSize(["UNSM", "Wärmepumpe"])).toBe(16);
  });

  it("budgets 11 mm at 300 dpi less a 1 mm pad at both edges, as a float", () => {
    expect(controlStripBudgetDots()).toBe(105.9212598425197);
    expect(CONTROL_SEGMENT_MM).toBe(CONTROL_PARTS[PART_TERMINAL].width_mm);
    // The segment cap (61 − 2 × 2 = 57) never binds below the 48 ceiling.
    expect(CONTROL_STRIP_CAP_DOTS).toBe(48);
  });
});

describe("controlLabelFits ⇄ control_label_fits", () => {
  it.each([
    ["UNSM", true],
    ["UStve", true],
    ["UStve12", true],
    ["0%", true],
    ["", true],
    ["Steuerbox 12", false],
    ["ABCDEFG", false],
    ["SG-Ready", false],
    ["Wärmepumpe", false],
  ])("%j fits: %s", (label, fits) => {
    expect(controlLabelFits(label)).toBe(fits);
  });
});

describe("controlStrip ⇄ control_strip", () => {
  it("is the parsed block's labels left → right, at its own size, 5,2 mm per terminal", () => {
    const strip = controlStrip(boardWith(defaultControlBlock()));
    expect(strip).toEqual({
      stripId: CONTROL_STRIP_ID,
      title: CONTROL_STRIP_TITLE,
      labels: ["UNSM", "60%", "30%", "0%", "UStve", "Stve"],
      sizeDots: 35,
      partCount: 6,
      blankCount: 0,
      lengthMm: 31.2,
      tooLong: null,
    });
    expect(CONTROL_STRIP_ID).toBe("control:block");
    expect(CONTROL_STRIP_TITLE).toBe("§14a-Klemmleiste (senkrecht beschriftet)");
  });

  it("does not exist without a block, when it is off, or without a terminal — no catalogue needed", () => {
    expect(controlStrip({ version: 1, rows: [] } as unknown as PanelDocument)).toBeNull();
    expect(controlStrip(boardWith(null))).toBeNull();
    expect(controlStrip(boardWith("block"))).toBeNull();
    expect(controlStrip(boardWith({ ...defaultControlBlock(), off: true }))).toBeNull();
    expect(controlStrip(boardWith({ ...defaultControlBlock(), terminals: [] }))).toBeNull();
  });

  it("keeps a blank terminal as an empty segment, counted, and sizes over the rest", () => {
    const strip = controlStrip(boardWith(blockWith(["UNSM", "", "Stve"])));
    expect(strip?.labels).toEqual(["UNSM", "", "Stve"]);
    expect(strip?.blankCount).toBe(1);
    expect(strip?.partCount).toBe(3);
    expect(strip?.lengthMm).toBe(15.6);
    expect(strip?.sizeDots).toBe(35);
  });

  it("names the first label too long for the terminal", () => {
    const strip = controlStrip(boardWith(blockWith(["UNSM", "Steuerbox 12", "SG-Ready"])));
    expect(strip?.tooLong).toBe("Steuerbox 12");
    expect(labelTooLongDetail("Steuerbox 12")).toBe(
      "„Steuerbox 12“ ist zu lang für die Klemme — in der §14a-Klemmleiste kürzen.",
    );
  });

  it("reads through the parser: control characters out, 12 code points, 12 terminals", () => {
    const raw = {
      terminals: Array.from({ length: 14 }, (_, i) => ({ id: `t${i + 1}`, label: i === 0 ? "  UN\u0001SM  " : "X" })),
    };
    const strip = controlStrip(boardWith(raw));
    expect(strip?.partCount).toBe(12);
    expect(strip?.labels[0]).toBe("UNSM");
  });

  it("never touches a frozen document", () => {
    const document = deepFreeze(boardWith(defaultControlBlock()));
    expect(() => controlStrip(document)).not.toThrow();
    expect(() => wireLabelSegments(document)).not.toThrow();
  });

  it("follows the fixture board with renamed and removed terminals", () => {
    const strip = controlStrip(boardDocument("control_3p_zb53s"));
    expect(strip?.labels).toEqual(["UNSM", "P60", "30%", "UStve", "Stve"]);
    expect(strip?.lengthMm).toBe(26);
  });

  it("has the server's stale-screen text", () => {
    expect(CONTROL_STALE_DETAIL).toBe(
      "Die §14a-Klemmleiste wurde geändert oder entfernt — nichts gedruckt. Bitte die Seite neu laden und erneut drucken.",
    );
  });
});

describe("klemmenStripIds — the Klemmen dialog's \"Alle\"", () => {
  const groups = [
    { strips: [{ stripId: "f1:leiste" }, { stripId: "w:block" }] },
    { strips: [{ stripId: "f2:leiste" }] },
  ] as unknown as Parameters<typeof klemmenStripIds>[0];

  it("lists every Leiste and Block in board order, the §14a strip last", () => {
    const control = controlStrip(boardWith(defaultControlBlock()));
    expect(klemmenStripIds(groups, control)).toEqual(["f1:leiste", "w:block", "f2:leiste", "control:block"]);
    expect(klemmenStripIds([], control)).toEqual(["control:block"]);
  });

  it("leaves the §14a strip out when there is none or a label is too long", () => {
    expect(klemmenStripIds(groups, null)).toEqual(["f1:leiste", "w:block", "f2:leiste"]);
    const tooLong = controlStrip(boardWith(blockWith(["Steuerbox 12"])));
    expect(klemmenStripIds(groups, tooLong)).toEqual(["f1:leiste", "w:block", "f2:leiste"]);
  });
});

describe("wireLabelSegments ⇄ wire_label_segments", () => {
  it("gives every named terminal two 15 mm sleeves, left → right", () => {
    const segments = wireLabelSegments(boardWith(defaultControlBlock()));
    expect(segments).toHaveLength(12);
    expect(segments?.map((segment) => segment.text)).toEqual([
      "UNSM", "UNSM", "60%", "60%", "30%", "30%", "0%", "0%", "UStve", "UStve", "Stve", "Stve",
    ]);
    expect(new Set(segments?.map((segment) => segment.widthMm))).toEqual(new Set([WIRE_LABEL_PIECE_MM]));
    expect(WIRE_STRIP_ID).toBe("control:wires");
  });

  it("skips blank labels and is null when nothing is named, the block is off or absent", () => {
    expect(wireLabelSegments(boardWith(blockWith(["UNSM", "", "Stve"])))?.map((s) => s.text)).toEqual([
      "UNSM", "UNSM", "Stve", "Stve",
    ]);
    expect(wireLabelSegments(boardWith(blockWith(["", ""])))).toBeNull();
    expect(wireLabelSegments(boardWith({ ...defaultControlBlock(), off: true }))).toBeNull();
    expect(wireLabelSegments(boardWith(null))).toBeNull();
    expect(NO_WIRE_LABELS_DETAIL).toBe("Keine Aderbeschriftung — erst Klemmen benennen.");
  });

  it("sizes like the rail strip on the tube, at most 48 dots (Python: 48 on 211-502, 42 on 211-501)", () => {
    const segments = wireLabelSegments(boardWith(defaultControlBlock())) ?? [];
    expect(wireLabelSize(segments, tubeMaterial("wago-211-502").widthMm)).toEqual({ sizeDots: 48, overflowing: [] });
    expect(wireLabelSize(segments, tubeMaterial("wago-211-501").widthMm)).toEqual({ sizeDots: 42, overflowing: [] });
    const long = wireLabelSegments(boardWith(blockWith(["WWWWWWWWWWWW", "Steuerbox 12"]))) ?? [];
    expect(wireLabelSize(long, 7.5)).toEqual({ sizeDots: 24, overflowing: ["WWWWWWWWWWWW", "WWWWWWWWWWWW"] });
  });
});

describe("tubeMaterial — the one chip of the Aderbeschriftung", () => {
  it("names the board's tube, its width and what to load", () => {
    expect(tubeMaterial("wago-211-502")).toEqual({
      id: "wago-211-502",
      label: "WAGO 211-502",
      widthMm: 7.5,
      hint: "Schrumpfschlauch WAGO 211-502 (Ø 4,8 mm) einlegen — nicht den 11-mm-Streifen.",
    });
    expect(tubeMaterial("wago-211-501")).toEqual({
      id: "wago-211-501",
      label: "WAGO 211-501",
      widthMm: 5,
      hint: "Schrumpfschlauch WAGO 211-501 (Ø 3,2 mm) einlegen — nicht den 11-mm-Streifen.",
    });
  });
});
