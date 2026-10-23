/**
 * The page never takes its width from a wide drawing (browser proof, 2026-10-23).
 *
 * Between 768 and 899 px (an iPad in portrait) the app shell's only column
 * was `1fr`, i.e. minmax(auto, 1fr), and `main.content` there is neither
 * `min-width: 0` (≤ 767 px) nor a scroll container (≥ 900 px). So the
 * column's minimum was the page's min-content, and a sideways scroller
 * counts its whole content in that: at 820 px the Schaltplan "Plan" drawing
 * made the page 5519 px wide, the "Aufbau" rails 1019 px and the
 * Wochenplanung grid 1195 px, in WebKit and Chromium alike. The root's
 * `overflow-x: clip` cut the rest off (the Aufbau tab button with it), and
 * Einpassen fitted the drawing to the widened box.
 *
 *  - The shell's content column is `minmax(0, 1fr)` at every width, so
 *    nothing inside the page can widen it.
 *  - The Schaltplan scrollers keep their content out of their own width as
 *    well (`contain: inline-size`), wherever they are rendered.
 *  - The Wochenplanung week grid scrolls inside its box instead of being
 *    clipped there.
 *
 * Asserted against the stylesheet source: vitest runs with `css: false`, and
 * jsdom computes no layout.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const TEST_DIR = (import.meta as unknown as { dirname: string }).dirname;

// The glob only lists the files (nothing is imported); they are read from
// disk, because `?raw` hands back "" for a stylesheet under `css: false`.
const SHEETS = Object.keys(import.meta.glob("../**/*.css"));

interface Rule {
  /** The enclosing at-rules, outermost first ("" at the top level). */
  context: string;
  selectors: string[];
  declarations: string;
}

function read(relative: string): string {
  const text = readFileSync(`${TEST_DIR}/${relative}`, "utf8");
  if (text.trim() === "") throw new Error(`${relative} came back empty`);
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Every style rule of a sheet, with the at-rules it sits in. */
function rules(css: string): Rule[] {
  const out: Rule[] = [];
  const atRules: string[] = [];
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === "}") {
      atRules.pop();
      start = i + 1;
    } else if (css[i] === "{") {
      const head = css.slice(start, i).trim();
      if (head.startsWith("@")) {
        atRules.push(head.replace(/\s+/g, " "));
        start = i + 1;
        continue;
      }
      const end = css.indexOf("}", i);
      out.push({ context: atRules.join(" "), selectors: head.split(",").map((part) => part.trim()), declarations: css.slice(i + 1, end) });
      i = end;
      start = end + 1;
    }
  }
  return out;
}

function value(declarations: string, property: string): string | null {
  const match = new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*([^;]+)`).exec(declarations);
  return match ? match[1].trim() : null;
}

/** `overflow-x` after these declaration blocks, in order; the shorthand sets it too. */
function overflowX(blocks: string[]): string | null {
  let result: string | null = null;
  for (const declaration of blocks.flatMap((block) => block.split(";"))) {
    const [property = "", ...rest] = declaration.split(":");
    const declared = rest.join(":").trim();
    if (property.trim() === "overflow-x") result = declared;
    else if (property.trim() === "overflow") result = declared.split(/\s+/)[0];
  }
  return result;
}

const ALL_RULES = SHEETS.flatMap((sheet) => rules(read(sheet)).map((rule) => ({ ...rule, sheet })));

describe("the app shell's content column", () => {
  const columns = ALL_RULES.filter((rule) => rule.selectors.includes(".app-shell"))
    .map((rule) => ({ context: rule.context, columns: value(rule.declarations, "grid-template-columns") }))
    .filter((rule): rule is { context: string; columns: string } => rule.columns !== null);

  it("is declared for the phone/tablet shell and for the sidebar shell", () => {
    expect(columns.map((rule) => rule.context)).toEqual(["", "@media (min-width: 900px)"]);
  });

  it.each(["", "@media (min-width: 900px)"])("has no content-sized minimum (%s)", (context) => {
    const declared = columns.find((rule) => rule.context === context)?.columns ?? "";
    expect(declared).toMatch(/minmax\(\s*0(?:px)?\s*,\s*1fr\s*\)$/);
    // No bare `fr` track left beside it: `1fr` alone is minmax(auto, 1fr).
    expect(declared.replace(/minmax\([^)]*\)/g, "")).not.toMatch(/fr\b/);
  });
});

describe("the Schaltplan scrollers never widen the page", () => {
  it.each([".sp-diagram-scroll", ".sp-rail-track"])("%s scrolls sideways and keeps its content out of the page's width", (selector) => {
    const base = ALL_RULES.filter((rule) => rule.context === "" && rule.selectors.includes(selector));
    expect(base).toHaveLength(1);
    expect(base[0].declarations).toMatch(/overflow(?:-x)?\s*:\s*auto/);
    expect(value(base[0].declarations, "contain")).toBe("inline-size");
  });
});

describe("the Wochenplanung week grid", () => {
  // Seven 164 px days are wider than the calendar box below ~1520 px. The
  // page's rule declared `overflow-x: auto` and then `overflow: hidden`; the
  // shorthand won, so Saturday and Sunday were cut off with nothing to reach
  // them by: a sideways swipe or wheel scrolled 0 px (WebKit and Chromium at
  // 820, 1180 and 1440 px).
  it("scrolls sideways instead of clipping", () => {
    const blocks = ALL_RULES.filter((rule) => rule.context === "" && rule.selectors.includes(".planning-page .planning-calendar-scroll"))
      .map((rule) => rule.declarations);
    expect(blocks.length).toBeGreaterThan(0);
    expect(overflowX(blocks)).toBe("auto");
  });

  it("the check itself sees a later shorthand", () => {
    expect(overflowX(["overflow-x: auto; overflow: hidden"])).toBe("hidden");
    expect(overflowX(["overflow: hidden", "overflow-x: auto"])).toBe("auto");
  });
});
