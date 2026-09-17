/**
 * The Werkstatt fixtures are gone, and nothing may bring them back.
 *
 * `components/werkstatt/mockData.ts` fed seven pages that showed a workshop
 * invented stock figures. Those pages now read the API and the module has been
 * deleted. Two things make that worth a test rather than a note.
 *
 * First, the module outlived its pages once already: "no page imports the
 * mocks" was true while three components the pages RENDER still did — two
 * order components for `formatMoney` / `shortDate` / the status helpers, and
 * the Bestand row for its row type — so the money formatter existed twice,
 * with the order LIST and the order DRAWER importing copies that could drift.
 *
 * Second, a fixture module is the easiest thing in the world to re-create
 * while wiring a new screen, and the failure it causes is silent: a number on
 * a wall that nobody can tell is made up.
 *
 * A grep is the test that would have caught it, so a grep is the test. The
 * sources come through `import.meta.glob` rather than `node:fs` because this
 * package has no Node type definitions.
 */
import { describe, expect, it } from "vitest";

const SOURCES = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const SELF = /components\/werkstatt\/mockData\.ts$/;

/** `import … from "…/mockData"` in any of its spellings, type-only included.
 *  Comments that merely NAME the module are not imports, and are allowed to
 *  record where these helpers came from. */
const IMPORT_RE = /(?:^|\n)\s*import\b[^;]*?from\s*["'][^"']*mockData["']/;

describe("components/werkstatt/mockData.ts", () => {
  it("reads the whole source tree, so the checks below cannot pass vacuously", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100);
  });

  it("no longer exists", () => {
    expect(Object.keys(SOURCES).filter((path) => SELF.test(path))).toEqual([]);
  });

  it("is imported by nothing", () => {
    const offenders = Object.entries(SOURCES)
      .filter(([path]) => !SELF.test(path))
      .filter(([, source]) => IMPORT_RE.test(source))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });
});
