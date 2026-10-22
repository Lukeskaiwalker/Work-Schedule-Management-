/**
 * Widget internals size themselves by the room they get, never by the screen
 * (docs/DASHBOARD.md §9.6).
 *
 * A small widget on a desktop is as narrow as a phone, and the admin previews
 * a phone layout on a desktop, so a width-based `@media` inside a widget
 * would lay it out for the wrong size. The frame sets
 * `container: dashboard-widget / inline-size`; widget sheets use
 * `@container dashboard-widget (…)` instead.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const TEST_DIR = (import.meta as unknown as { dirname: string }).dirname;
const PREFIX = "../components/dashboard/widgets/";
const WIDTH_MEDIA = /@media[^{]*(min|max)-width/;

// The glob only lists the files (nothing is imported); they are read from
// disk, because vitest runs with `css: false` and `?raw` would hand back ""
// for a stylesheet (see nodeBuiltins.d.ts).
const FILES = Object.keys(import.meta.glob("../components/dashboard/widgets/**/*.css"));

function read(relative: string): string {
  return readFileSync(`${TEST_DIR}/${relative}`, "utf8");
}

describe("widget stylesheets", () => {
  it("exist for every widget group, and are read for real", () => {
    const groups = FILES.map((file) => file.slice(PREFIX.length).split("/")[0]);
    expect(new Set(groups)).toEqual(new Set(["personal", "planning", "werkstatt", "office", "shortcuts"]));
    // An empty read would make the next test pass on nothing.
    for (const file of FILES) expect(read(file).trim()).not.toBe("");
  });

  it("never use a width-based @media query", () => {
    const offenders = FILES.filter((file) => WIDTH_MEDIA.test(read(file)));
    expect(offenders.map((file) => file.slice(PREFIX.length))).toEqual([]);
  });

  it("the check itself catches both spellings", () => {
    expect(WIDTH_MEDIA.test("@media (max-width: 767px) { .x { } }")).toBe(true);
    expect(WIDTH_MEDIA.test("@media screen and (min-width:1280px){.x{}}")).toBe(true);
    expect(WIDTH_MEDIA.test("@media (prefers-reduced-motion: reduce) { .x { } }")).toBe(false);
    expect(WIDTH_MEDIA.test("@container dashboard-widget (min-width: 320px) { .x { } }")).toBe(false);
  });
});
