/**
 * The §14a sheet, the field bar's "§14a-Klemmen" and "Automatisch ergänzt"
 * are sized for gloves (docs/PANEL_ENCLOSURE_R4.md §8: every control 56 px,
 * every text field 16 px so iOS Safari does not zoom), and their grids keep
 * text columns shrinkable (the app root clips overflow-x: a column that
 * cannot shrink pushes the sheet wider than a 390 px phone).
 *
 * Asserted against the stylesheet source: vitest runs with `css: false`, and
 * jsdom computes no layout.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const TEST_DIR = (import.meta as unknown as { dirname: string }).dirname;
const CSS = readFileSync(`${TEST_DIR}/../styles/schaltplan-enclosure-control.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of every rule (media queries aside) whose selector list contains `selector` exactly, in source order. */
function declarationsFor(selector: string): string {
  const topLevel = CSS.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*\s*\}/g, "");
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  const found: string[] = [];
  for (let match = rule.exec(topLevel); match; match = rule.exec(topLevel)) {
    const selectors = match[1].split(",").map((part) => part.trim().replace(/\s+/g, " "));
    if (selectors.includes(selector)) found.push(match[2]);
  }
  return found.join(";");
}

const px = (declarations: string, property: string): number | null => {
  const found = new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*(\\d+(?:\\.\\d+)?)px`).exec(declarations);
  return found ? Number(found[1]) : null;
};

describe("§14a sheet and prep list — glove targets", () => {
  it.each([
    ".sp-encl-control-input",
    ".sp-encl-control-select",
    '.sp-encl-control-sheet .sp-field input[type="text"]',
    ".sp-encl-control-sheet .sp-field select",
    ".sp-encl-prep-item select",
    '.sp-encl-prep-item .sp-field input[type="text"]',
  ])("%s is 56 px high with a 16 px font", (selector) => {
    const rule = declarationsFor(selector);
    expect(rule).not.toBe("");
    expect(px(rule, "min-height")).toBe(56);
    expect(px(rule, "font-size")).toBe(16);
  });

  it.each([
    ".sp-encl-control-actions > .sp-btn",
    ".sp-encl-control-footer > .sp-btn",
    ".sp-encl-prep-controls .sp-btn",
    ".sp-encl-prep-item",
    ".sp-encl-fieldbar-btn--control",
  ])("%s is at least 56 px high", (selector) => {
    expect(px(declarationsFor(selector), "min-height")).toBe(56);
  });
});

describe("§14a sheet and prep list — narrow screens", () => {
  it("lets the terminal row's name column shrink, and wraps the row below 480 px", () => {
    expect(declarationsFor(".sp-encl-control-row")).toMatch(/grid-template-columns:\s*32px minmax\(0, 1fr\) minmax\(8rem, 10rem\) auto/);
    const narrow = /@media \(max-width: 480px\)\s*\{\s*\.sp-encl-control-row\s*\{([^}]*)\}/.exec(CSS);
    expect(narrow?.[1]).toMatch(/grid-template-columns:\s*32px minmax\(0, 1fr\) auto/);
    expect(narrow?.[1]).toMatch(/"pos name name"/);
  });

  it("keeps the prep list's text column shrinkable and breaking long article texts", () => {
    expect(declarationsFor(".sp-encl-prep-item")).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\) auto/);
    const text = declarationsFor(".sp-encl-prep-text");
    expect(text).toMatch(/min-width:\s*0/);
    expect(text).toMatch(/overflow-wrap:\s*anywhere/);
    expect(/@media \(max-width: 600px\)\s*\{\s*\.sp-encl-prep-item\s*\{([^}]*)\}/.exec(CSS)?.[1]).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
  });

  it("never lets a settings column grow past the sheet", () => {
    expect(declarationsFor(".sp-encl-control-settings")).toMatch(/minmax\(min\(100%, 14rem\), 1fr\)/);
  });
});
