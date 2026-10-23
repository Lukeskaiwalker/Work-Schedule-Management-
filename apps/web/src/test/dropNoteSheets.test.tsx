/**
 * The drop note and the sheets (docs/PANEL_ENCLOSURE_R2.md §6.5): the note
 * is a fixed bar at the bottom, above the sheet backdrop, and stays until
 * it is dismissed or the board changes. A sheet opened while it is up —
 * RegroupConfirm, the device palette, RailSheet — must not lose its last
 * actions under the bar. So while a note is up, DropNote tells the page its
 * height (`data-sp-dropnote` and `--sp-dropnote-h` on <html>), and every
 * sheet ends above it: a phone's bottom sheet sits on top of the bar, a
 * tablet's centred dialog moves up by half of it.
 *
 * The CSS half is asserted against the stylesheet source: vitest runs with
 * `css: false`, and jsdom computes no layout.
 */
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

import { DropNote } from "../components/schaltplan/enclosure/DropNote";

const NOTE_PX = 132;
const root = () => document.documentElement;

beforeEach(() => {
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (!this.classList.contains("sp-encl-dropnote")) return original.call(this);
    return { left: 0, top: 700, right: 390, bottom: 700 + NOTE_PX, x: 0, y: 700, width: 390, height: NOTE_PX, toJSON: () => ({}) } as DOMRect;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("DropNote — the sheets end above it", () => {
  it("tells the page its height while a note is up, and forgets it when the note goes", () => {
    const note = { lines: ["F1.3 verschoben: F1 · Verteiler 1, Platz 2."], canUndo: true };
    const view = render(<DropNote note={note} onUndo={() => undefined} onDismiss={() => undefined} />);
    expect(root().hasAttribute("data-sp-dropnote")).toBe(true);
    expect(root().style.getPropertyValue("--sp-dropnote-h")).toBe(`${NOTE_PX}px`);

    view.rerender(<DropNote note={null} onUndo={() => undefined} onDismiss={() => undefined} />);
    expect(root().hasAttribute("data-sp-dropnote")).toBe(false);
    expect(root().style.getPropertyValue("--sp-dropnote-h")).toBe("");

    view.rerender(<DropNote note={note} onUndo={() => undefined} onDismiss={() => undefined} />);
    expect(root().hasAttribute("data-sp-dropnote")).toBe(true);
    view.unmount();
    expect(root().hasAttribute("data-sp-dropnote")).toBe(false);
  });

  it("says nothing to the page without a note", () => {
    const view = render(<DropNote note={null} onUndo={() => undefined} onDismiss={() => undefined} />);
    expect(root().hasAttribute("data-sp-dropnote")).toBe(false);
    view.unmount();
  });
});

const TEST_DIR = (import.meta as unknown as { dirname: string }).dirname;
const LIFTED = "html[data-sp-dropnote] .sp-sheet";

function dragCss(): string {
  const text = readFileSync(`${TEST_DIR}/../styles/schaltplan-enclosure-drag.css`, "utf8");
  if (text.trim() === "") throw new Error("schaltplan-enclosure-drag.css came back empty");
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The declarations of every rule for `selector`, top level first, then those inside `@media (min-width: 768px)`. */
function rulesFor(css: string, selector: string): { top: string[]; tablet: string[] } {
  const media = /@media\s*\(min-width:\s*768px\)\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g;
  const tabletBlocks = [...css.matchAll(media)].map((match) => match[1]);
  const outside = css.replace(media, "");
  const declarations = (text: string) =>
    [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((match) => match[1].split(",").map((part) => part.trim()).includes(selector)).map((match) => match[2]);
  return { top: declarations(outside), tablet: tabletBlocks.flatMap(declarations) };
}

describe("the lifted sheets in schaltplan-enclosure-drag.css", () => {
  it("puts a phone's bottom sheet on top of the note and shortens it by the note's height", () => {
    const [rule] = rulesFor(dragCss(), LIFTED).top;
    expect(rule).toBeDefined();
    expect(rule).toMatch(/bottom\s*:\s*calc\(\s*var\(--sp-dropnote-h,\s*0px\)\s*\+\s*env\(safe-area-inset-bottom,\s*0px\)\s*\)/);
    expect(rule).toMatch(/max-height\s*:\s*calc\(\s*88vh\s*-\s*var\(--sp-dropnote-h,\s*0px\)\s*\)/);
  });

  it("moves a tablet's centred dialog up by half the note and shortens it", () => {
    const [rule] = rulesFor(dragCss(), LIFTED).tablet;
    expect(rule).toBeDefined();
    expect(rule).toMatch(/bottom\s*:\s*auto/);
    expect(rule).toMatch(/top\s*:\s*calc\(\s*50%\s*-\s*var\(--sp-dropnote-h,\s*0px\)\s*\/\s*2\s*\)/);
    expect(rule).toMatch(/max-height\s*:\s*calc\(\s*84vh\s*-\s*var\(--sp-dropnote-h,\s*0px\)\s*\)/);
  });
});
