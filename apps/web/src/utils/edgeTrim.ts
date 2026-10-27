/**
 * The edge trim every cabinet twin uses for user text (BMK, row labels, meter
 * numbers, the Vorsicherung) — the TypeScript twin of `text()` in
 * `apps/api/app/services/panel_enclosure_layout.py`, pinned by the fixture
 * table `edge_trim`.
 *
 * Python's `str.strip()` and JS's `String.prototype.trim()` disagree:
 * Python strips U+001C–U+001F and U+0085 but keeps U+FEFF, JS the other way
 * round. Both twins therefore strip one explicit set: every C0/C1 control,
 * DEL, the no-break space and the Unicode spaces either side strips.
 */

const EDGE = "\\u0000-\\u0020\\u007f-\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff";
const EDGE_JUNK = new RegExp(`^[${EDGE}]+|[${EDGE}]+$`, "g");

/** A string with its edge junk removed; "" for anything that is not a string. */
export function edgeTrimmed(value: unknown): string {
  return typeof value === "string" ? value.replace(EDGE_JUNK, "") : "";
}
