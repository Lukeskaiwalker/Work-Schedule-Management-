/**
 * The Schrank tab's own scroll containers, held to what jsdom cannot see
 * (browser proof of docs/PANEL_ENCLOSURE_R2.md §14.4, 2026-10-23).
 *
 *  - The field bar and the drawing scroll sideways inside the tab. The app
 *    shell's column is `1fr` (= minmax(auto, 1fr)), and WebKit counts a
 *    scroll container's content in that track's minimum. With round 2's
 *    "Klemmen Feld {n}" buttons a ZB34S field bar was wider than an iPad in
 *    portrait, the page grew past the screen (root `overflow-x: clip` hid
 *    the rest), and fit-to-width then picked a larger zoom from the wider
 *    page. `contain: inline-size` keeps their content out of the page's
 *    width.
 *  - The close-up's drawing scroller (`.sp-term-scroll`, §7.2) sits in the
 *    sheet body's flex column; a scroll container's automatic minimum
 *    height is 0, so as a shrinking flex item it collapsed to its 2 px
 *    border in Chromium and the drawing vanished. It must not shrink.
 *
 * Asserted against the stylesheet source: vitest runs with `css: false`, and
 * jsdom computes no layout.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const TEST_DIR = (import.meta as unknown as { dirname: string }).dirname;

function stylesheet(name: string): string {
  const text = readFileSync(`${TEST_DIR}/../styles/${name}`, "utf8");
  if (text.trim() === "") throw new Error(`${name} came back empty`);
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The declarations of the rule whose selector list is exactly `selector`. */
function declarationsFor(css: string, selector: string): string {
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  for (let match = rule.exec(css); match; match = rule.exec(css)) {
    if (match[1].split(",").map((part) => part.trim()).includes(selector)) return match[2];
  }
  return "";
}

describe("the Schrank tab's scrollers never widen the page", () => {
  it.each([".sp-encl-fieldbar", ".sp-encl-scroll"])("%s scrolls sideways and keeps its content out of the page's width", (selector) => {
    const rule = declarationsFor(stylesheet("schaltplan-enclosure.css"), selector);
    expect(rule).toMatch(/overflow(?:-x)?\s*:\s*auto/);
    expect(rule).toMatch(/contain\s*:\s*inline-size/);
  });
});

describe("the close-up's drawing scroller", () => {
  it("never shrinks inside the sheet body's flex column", () => {
    const rule = declarationsFor(stylesheet("schaltplan-enclosure-terminals.css"), ".sp-term-scroll");
    expect(rule).toMatch(/overflow-x\s*:\s*auto/);
    expect(rule).toMatch(/(?:^|;|\s)flex\s*:\s*none|flex-shrink\s*:\s*0/);
  });
});
