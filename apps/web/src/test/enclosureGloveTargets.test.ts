/**
 * The Schrank tab's sheets are sized for gloves on a workshop tablet: every
 * target at least 56 px (docs/PANEL_ENCLOSURE.md §11, owner decision). The
 * DeviceInspector and the device palette are shared with the Plan tab and
 * carry 40 px ‹ › × and 48 px actions there; inside the Schrank stack they
 * get `sp-sheet--glove`, and this stylesheet must lift them to 56 px — the
 * core path rail → tile → inspector → × back to the rail runs through them.
 *
 * Asserted against the stylesheet source: vitest runs with `css: false`, and
 * jsdom computes no layout, so a render could not tell 40 px from 56 px.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const TEST_DIR = (import.meta as unknown as { dirname: string }).dirname;

function readSource(relativeToSrc: string): string {
  const text = readFileSync(`${TEST_DIR}/../${relativeToSrc}`, "utf8");
  if (text.trim() === "") throw new Error(`${relativeToSrc} came back empty`);
  return text;
}

const SHEETS_CSS = readSource("styles/schaltplan-enclosure-sheets.css");

/** The declarations of the rule whose selector list contains `selector` exactly. */
function declarationsFor(css: string, selector: string): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  for (let match = rule.exec(withoutComments); match; match = rule.exec(withoutComments)) {
    const selectors = match[1].split(",").map((part) => part.trim().replace(/\s+/g, " "));
    if (selectors.includes(selector)) return match[2];
  }
  return "";
}

const px = (declarations: string, property: string): number | null => {
  const found = new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*(\\d+(?:\\.\\d+)?)px`).exec(declarations);
  return found ? Number(found[1]) : null;
};

describe("glove-sized shared sheets in the Schrank stack", () => {
  it.each([".sp-sheet--glove .sp-sheet-nav", ".sp-sheet--glove .sp-sheet-close"])("%s is a 56 px square", (selector) => {
    const rule = declarationsFor(SHEETS_CSS, selector);
    expect(rule).not.toBe("");
    expect(px(rule, "width")).toBe(56);
    expect(px(rule, "height")).toBe(56);
    expect(px(rule, "min-width")).toBe(56);
    expect(px(rule, "min-height")).toBe(56);
  });

  it("lifts the inspector's action buttons, grid ones included, to 56 px", () => {
    for (const selector of [".sp-sheet--glove .sp-btn", ".sp-sheet--glove .sp-sheet-actions--grid .sp-btn"]) {
      expect(px(declarationsFor(SHEETS_CSS, selector), "min-height")).toBe(56);
    }
  });
});
