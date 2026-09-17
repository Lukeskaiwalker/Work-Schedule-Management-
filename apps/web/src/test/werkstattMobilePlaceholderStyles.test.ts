/**
 * The "In Arbeit / under construction" card must not render under the finished
 * phone article screen.
 *
 * `WerkstattPage` renders `.werkstatt-desktop-only-placeholder` for every
 * `werkstattTab === "artikel"`, with no viewport condition, and
 * `WerkstattMobileArtikelPage` self-gates on the same tab — so on a phone both
 * rendered, as siblings, and a Monteur scrolling past the real LAGER /
 * UNTERWEGS / BESTAND figures read "Dieser Werkstatt-Bereich wird gerade
 * gebaut" under the screen he was standing on. The class had NO rule anywhere
 * in the repo, so nothing hid it.
 *
 * Asserted against the stylesheet source rather than a render, because jsdom
 * does not evaluate `@media` when computing styles — a rendering test here
 * would pass whether or not the rule existed, which is the whole failure mode.
 * The proper one-line gate belongs in `WerkstattPage.tsx` (`!isMobile && …`),
 * a file this group does not own; see the handoff note. This rule is the half
 * that is ours, and it stands on its own: the class is by its own name the
 * desktop-only stand-in, so the phone breakpoint is exactly where it has no
 * business rendering.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * Read a source file off disk.
 *
 * Not `import … from "…?raw"`: vitest runs with `css: false`, so a CSS import
 * hands back an empty string and every assertion below would pass against
 * nothing. `import.meta.dirname` (an absolute path under vitest) rather than
 * `process.cwd()`, so it does not matter which directory the suite was started
 * from; `node:fs` is typed by `nodeBuiltins.d.ts`, which explains itself.
 */
const TEST_DIR = (import.meta as unknown as { dirname: string }).dirname;

function readSource(relativeToSrc: string): string {
  const text = readFileSync(`${TEST_DIR}/../${relativeToSrc}`, "utf8");
  // A stub or an empty file would make every assertion below vacuous.
  if (text.trim() === "") throw new Error(`${relativeToSrc} came back empty`);
  return text;
}

const MOBILE_CSS = readSource("styles/mobile.css");
const VIEWPORT_HOOK = readSource("hooks/useIsMobileViewport.ts");

/** The body of the first `@media <query>` block, braces balanced. */
function mediaBlock(css: string, query: string): string {
  const head = css.indexOf(`@media ${query}`);
  if (head < 0) return "";
  const open = css.indexOf("{", head);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return "";
}

describe("Werkstatt Mobile — the desktop placeholder on a phone", () => {
  it("is hidden at the phone breakpoint", () => {
    const phone = mediaBlock(MOBILE_CSS, "(max-width: 767px)");
    expect(phone).not.toBe("");

    // The declaration, whitespace-insensitively, for the compound selector
    // that outranks `.werkstatt-tab-page { display: flex }` in styles.css.
    const rules = phone.replace(/\s+/g, " ");
    expect(rules).toContain(".werkstatt-tab-page.werkstatt-desktop-only-placeholder");
    expect(rules).toMatch(/\.werkstatt-desktop-only-placeholder[^{]*\{[^}]*display: *none/);
  });

  it("uses the same breakpoint the phone screens gate themselves on", () => {
    // useIsMobileViewport subscribes to `(max-width: 767px)`. A rule at a
    // different width would hide the card on one side of the boundary while
    // the mobile screen renders on the other.
    expect(VIEWPORT_HOOK).toContain("max-width: 767px");
  });
});
