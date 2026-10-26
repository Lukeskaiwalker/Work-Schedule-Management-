/**
 * Cable cross-section and fuse rating out of free text
 * (docs/PANEL_ENCLOSURE_R4.md §3.5) — the TypeScript twin of
 * `apps/api/app/services/cable_section_parse.py`, pinned by the fixture
 * tables `infeed_parse` and `fuse_parse`.
 *
 * `supply.incoming` and `supply.fuse` are whatever the planner typed:
 * "NYY-J 5x16 mm²", "5G25", "NAYY-J 4x50", "NH00 100A". The cabinet
 * preparation reads the infeed cross-section from it (R4-10, no schema
 * change). Hence the narrow rules both twins keep: the text is normalised to
 * ASCII spacing first, the patterns carry no `u` flag (Python compiles with
 * `re.ASCII`), and spaces are spelled `" *"`, never `\s`, which differs. The
 * leading lookbehind is applied by hand (`afterNoNumber`), see below.
 *
 * One deliberate correction of §3.5's PAIR, made in both twins: the
 * lookahead after the cross-section is `(?![0-9]|\.[0-9])`, not
 * `(?![0-9.])`, because the comma of "NYY-J 5x16, 3x63A" is normalised to
 * "." and the literal pattern would then find no pair at all (a decimal like
 * "5x16.5" is still never cut to 16).
 */

import type { CableSection } from "../types/panelEnclosure";

/** A cross-section outside this range is no conductor of a house infeed ("1x500" is a cable count). */
export const MIN_SECTION_MM2 = 1.5;
export const MAX_SECTION_MM2 = 300;
const MAX_CORES = 5;

const REPLACEMENTS: readonly (readonly [string, string])[] = [["²", "2"], ["×", "x"], ["*", "x"], [",", "."], ["qmm", "mm"]];
/** Every Unicode space the planner's keyboard may produce, mapped to U+0020. */
const SPACES = /[\u0009-\u000d\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/g;

// §3.5's patterns without their leading `(?<![0-9.])`: a regex literal with a
// lookbehind is a syntax error for Safari before 16.4 and would take the whole
// bundle down on an older iPad, so `afterNoNumber` applies it by hand.
const PAIR = /([0-9]) *[xg] *([0-9]+(?:\.[0-9]+)?)(?![0-9]|\.[0-9])(?! *a\b)/g;
const EXTRA = /^ *[/+] *[0-9]/;
const MM = /([0-9]+(?:\.[0-9]+)?) *mm/g;
const FUSE = /([0-9]+) *a(?:mpere)?\b/g;
const ALU = /\bna[a-z0-9]*y|\bna2x|\balu?(?:minium)?\b/;
const NUMBER_CHAR = /[0-9.]/;

/**
 * Every match of `pattern` (global, never empty) left → right that is not
 * preceded by a digit or ".": exactly what `(?<![0-9.])pattern` finds — a
 * start refused by the lookbehind is retried one character later, as the
 * regex engine would.
 */
function afterNoNumber(pattern: RegExp, text: string): RegExpExecArray[] {
  const scan = new RegExp(pattern.source, "g");
  const found: RegExpExecArray[] = [];
  for (let match = scan.exec(text); match !== null; match = scan.exec(text)) {
    if (match.index > 0 && NUMBER_CHAR.test(text[match.index - 1])) {
      scan.lastIndex = match.index + 1;
      continue;
    }
    found.push(match);
  }
  return found;
}

/** Lower case, `²`→2, `×`/`*`→x, `,`→., `qmm`→mm, odd spaces → U+0020; not a string → "". */
export function normaliseCableText(text: unknown): string {
  if (typeof text !== "string") return "";
  let out = text.toLowerCase();
  for (const [from, to] of REPLACEMENTS) out = out.split(from).join(to);
  return out.replace(SPACES, " ");
}

const inRange = (mm2: number): boolean => MIN_SECTION_MM2 <= mm2 && mm2 <= MAX_SECTION_MM2;

/** The first pair with the largest cross-section in range (left → right). */
function bestPair(text: string): RegExpExecArray | null {
  let best: RegExpExecArray | null = null;
  for (const match of afterNoNumber(PAIR, text)) {
    const mm2 = Number(match[2]);
    if (inRange(mm2) && (best === null || mm2 > Number(best[2]))) best = match;
  }
  return best;
}

/**
 * 2…5 from the pair; "+16" / "/16" right after it adds the separate
 * conductor. A pair whose own count is no cable's core count (1, 6…9) stays
 * null: the extra conductor then has nothing to add to.
 */
function pairCores(text: string, match: RegExpExecArray): number | null {
  const count = Number(match[1]);
  if (count < 2 || count > MAX_CORES) return null;
  const end = match.index + match[0].length;
  return EXTRA.test(text.slice(end)) ? Math.min(count + 1, MAX_CORES) : count;
}

function firstMm(text: string): number | null {
  for (const match of afterNoNumber(MM, text)) {
    const mm2 = Number(match[1]);
    if (inRange(mm2)) return mm2;
  }
  return null;
}

/** `{ mm2, cores, aluminium }` (§3.5); never throws. */
export function parseCableSection(text: unknown): CableSection {
  const normalised = normaliseCableText(text);
  const aluminium = ALU.test(normalised);
  const pair = bestPair(normalised);
  if (pair) return { mm2: Number(pair[2]), cores: pairCores(normalised, pair), aluminium };
  return { mm2: firstMm(normalised), cores: null, aluminium };
}

/** The largest ampere figure in the text ("NH00 100A" → 100), else null. */
export function parseFuseAmps(text: unknown): number | null {
  let best: number | null = null;
  for (const match of afterNoNumber(FUSE, normaliseCableText(text))) {
    const amps = Number.parseInt(match[1], 10);
    if (best === null || amps > best) best = amps;
  }
  return best;
}
