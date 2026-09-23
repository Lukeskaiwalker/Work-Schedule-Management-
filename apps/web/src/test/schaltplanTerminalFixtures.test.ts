/**
 * The Reihenklemmen twin, pinned against the backend's own output.
 *
 * `fixtures/terminalFixtures.json` was written by
 * `apps/api/app/services/schaltplan_terminals.py`: for four boards the input
 * document and exactly what the Python derivation returns — groups, strips,
 * the board font size, the Stückliste, the counts, the legend labels. This
 * test walks every board through the TypeScript derivation and demands the
 * same shapes, key for key. A rule changed on one side only turns this red,
 * which is the whole point: a preview that promises a marker the printer
 * does not produce is a board built wrong.
 */
import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/terminalFixtures.json";
import {
  deriveTerminals,
  deviceTerminalLabels,
  terminalBom,
  terminalCounts,
  terminalFontSize,
  terminalStrips,
} from "../utils/schaltplanTerminals";
import type { PanelDocument } from "../types/schaltplan";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface Board {
  document: PanelDocument;
  groups: Json;
  strips_all: Json;
  font: [number, string[]];
  bom: Json;
  counts: Record<string, number>;
  device_labels: Record<string, string[]>;
}

const BOARDS = fixtures as unknown as Record<string, Board>;

const camel = (key: string) => key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());

/**
 * The backend's snake_case shape as the twin spells it. Device dicts stay
 * snake_case — `PanelDevice` mirrors the API — and the `(text, width)`
 * tuples of a strip's segments and cells become `FitSegment`s.
 */
function toTwinShape(value: Json, parentKey = ""): unknown {
  if (Array.isArray(value)) {
    if (parentKey === "segments" || parentKey === "cells") {
      return value.map((tuple) => {
        const [text, widthMm] = tuple as [string, number];
        return { text, widthMm };
      });
    }
    return value.map((item) => toTwinShape(item, parentKey));
  }
  if (value && typeof value === "object") {
    if (parentKey === "head_device") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [camel(key), toTwinShape(item, key)]));
  }
  return value;
}

describe("Reihenklemmen twin — every board of the backend fixture", () => {
  const names = Object.keys(BOARDS);

  it("covers the four boards the backend wrote", () => {
    expect(names.sort()).toEqual(["block_only", "overrides", "standard", "two_rcd"]);
  });

  for (const name of names) {
    const board = BOARDS[name];

    describe(name, () => {
      const groups = deriveTerminals(board.document);

      it("derives the same groups, strips and terminals", () => {
        expect(groups).toEqual(toTwinShape(board.groups));
      });

      it("prints the same strips for the whole board", () => {
        expect(terminalStrips(groups)).toEqual(toTwinShape(board.strips_all));
      });

      it("fits the same board font size", () => {
        const [sizeDots, overflowing] = board.font;
        expect(terminalFontSize(groups, 11)).toEqual({ sizeDots, overflowing });
      });

      it("sums the same Stückliste", () => {
        expect(terminalBom(groups)).toEqual(toTwinShape(board.bom));
      });

      it("counts the same terminals, strips, groups and devices", () => {
        expect(terminalCounts(groups)).toEqual(board.counts);
      });

      it("labels the same devices for the legend", () => {
        expect(deviceTerminalLabels(groups)).toEqual(board.device_labels);
      });
    });
  }
});
