/**
 * The strip preview and the printed strip, held to ONE fixture.
 *
 * `fixtures/stripParityFixtures.json` was computed from the formulas alone
 * (300 dpi, half-up rounding once, Arial advances) and is walked by both
 * suites: `apps/api/tests/test_label_strip_parity.py` checks the Python
 * layout and the rendered EZPL against it, this file checks the TypeScript
 * twin. The printer feeds 300 dots per inch — 11,81 dots per mm, not 12
 * (physical test T4, 13.10.2026) — so a preview still drawn at 12 would put
 * every font and every cut 1,6 % off what comes out of the printer.
 */
import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/stripParityFixtures.json";
import {
  DOTS_PER_MM,
  STRIP_LEAD_MM,
  boardFontSize,
  maxFontDots,
  mmToDots,
  stripSegments,
} from "../utils/schaltplanStrip";
import { blockCellSizeDots, blockRowSizeDots } from "../utils/schaltplanTerminals";
import { PX_PER_DOT, PX_PER_MM } from "../components/schaltplan/StripSvg";
import type { PanelDevice } from "../types/schaltplan";

interface Rail {
  row_id: string;
  segments: { text: string; width_mm: number; start_mm: number }[];
  length_mm: number;
  cuts_dots: number[];
  total_dots: number;
}

interface Board {
  document: { rows: { id: string; devices: PanelDevice[] }[] };
  font: [number, string[]];
  rails: Rail[];
}

interface Block {
  name: string;
  x_label: string;
  cells: [string, number][];
  length_mm: number;
  row_sizes: number[];
  cell_sizes: number[];
  cuts_dots: number[];
}

const FIXTURE = fixtures as unknown as {
  dots_per_mm: number;
  strip_width_mm: number;
  max_font_dots: number;
  boards: Record<string, Board>;
  blocks: Block[];
};

describe("strip parity with the API", () => {
  it("draws at the printer's physical 300 dpi, the API's own number", () => {
    expect(DOTS_PER_MM).toBe(FIXTURE.dots_per_mm);
    expect(DOTS_PER_MM).toBe(300 / 25.4);
    expect(PX_PER_DOT).toBe(PX_PER_MM / FIXTURE.dots_per_mm);
    expect(maxFontDots(FIXTURE.strip_width_mm)).toBe(FIXTURE.max_font_dots);
    expect([mmToDots(1), mmToDots(3), mmToDots(80), mmToDots(210)]).toEqual([12, 35, 945, 2480]);
  });

  it.each(Object.keys(FIXTURE.boards))("lays out board %s as the printer prints it", (name) => {
    const board = FIXTURE.boards[name];
    const result = boardFontSize(board.document, FIXTURE.strip_width_mm);
    expect([result.sizeDots, result.overflowing]).toEqual(board.font);

    for (const rail of board.rails) {
      const row = board.document.rows.find((candidate) => candidate.id === rail.row_id);
      expect(row).toBeDefined();
      const segments = stripSegments(row!);
      expect(segments.map((s) => ({ text: s.text, width_mm: s.widthMm, start_mm: s.start }))).toEqual(rail.segments);
      const cuts = [...segments.map((s) => s.start), rail.length_mm].map((mm) => mmToDots(STRIP_LEAD_MM + mm));
      expect(cuts).toEqual(rail.cuts_dots);
      expect(mmToDots(STRIP_LEAD_MM + rail.length_mm + STRIP_LEAD_MM)).toBe(rail.total_dots);
    }
  });

  it.each(FIXTURE.blocks.map((block) => [block.name, block] as const))(
    "sizes the Block label %s like the printer",
    (_name, block) => {
      expect([blockRowSizeDots(block.name, block.length_mm), blockRowSizeDots(block.x_label, block.length_mm)]).toEqual(
        block.row_sizes,
      );
      expect(block.cells.map(([text, width]) => blockCellSizeDots(text, width))).toEqual(block.cell_sizes);
      let start = 0;
      const cuts = [mmToDots(STRIP_LEAD_MM)];
      for (const [, width] of block.cells) {
        start += width;
        cuts.push(mmToDots(STRIP_LEAD_MM + start));
      }
      expect(cuts).toEqual(block.cuts_dots);
    },
  );
});
