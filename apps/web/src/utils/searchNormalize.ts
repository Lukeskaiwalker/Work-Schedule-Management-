/**
 * Client-side text normalisation for list searches, mirroring the server.
 *
 * `apps/api/app/services/search_matching.py` already decided how a query typed
 * by a tradesperson should be matched (`normalize_query`, `identifier_key`,
 * `term_variants`). Any client-side search that behaves differently from the
 * server-side one is a second, contradictory search surface, so the rules are
 * reproduced here rather than reinvented:
 *
 * - **casefold + whitespace collapse** (`normalize_query`)
 * - **separator-free identifier equality** (`identifier_key`) so `2024-021`
 *   finds `2024021` and vice versa
 * - **decimal separator drift** (`term_variants`) so `3x1,5` finds `3x1.5`
 *
 * One rule is added on top, because the client can afford it and Postgres
 * `ILIKE` cannot: **diacritic folding**, in both directions. `Müller` is folded
 * to *both* `muller` (combining marks dropped) and `mueller` (German
 * transliteration), so all three spellings match each other symmetrically.
 */

const WHITESPACE_RE = /\s+/g;
const COMBINING_MARKS_RE = /[\u0300-\u036f]/g;
const NON_ALNUM_RE = /[^a-z0-9]+/g;
const DECIMAL_COMMA_RE = /(\d),(\d)/g;
const DECIMAL_POINT_RE = /(\d)\.(\d)/g;
const SHARP_S_RE = /ß/g;

/** German transliterations. Applied to the NFC-composed lowercase form. */
const UMLAUT_EXPANSIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/ä/g, "ae"],
  [/ö/g, "oe"],
  [/ü/g, "ue"],
  [SHARP_S_RE, "ss"],
];

/** A query token, pre-expanded into every spelling worth matching. */
export type SearchToken = {
  /** Folded + decimal-variant spellings, matched as substrings. */
  readonly text: readonly string[];
  /** Punctuation-free form; empty when the token has no alphanumerics. */
  readonly ident: string;
};

/** One record's searchable surface, pre-folded once per record. */
export type SearchHaystack = {
  readonly text: readonly string[];
  readonly ident: readonly string[];
};

/** Casefold and collapse whitespace. Mirrors `normalize_query`. */
export function normalizeQuery(value: string): string {
  return value.toLowerCase().replace(WHITESPACE_RE, " ").trim();
}

/** Split a free-text query into whitespace-separated tokens. */
export function tokenizeQuery(value: string): string[] {
  return normalizeQuery(value)
    .split(" ")
    .filter((token) => token.length > 0);
}

/** Reduce an identifier to comparable form: `2024-021` -> `2024021`. */
export function identifierKey(value: string): string {
  return value.toLowerCase().replace(NON_ALNUM_RE, "");
}

/** Spellings of a token that differ only in decimal separator. */
export function termVariants(token: string): string[] {
  const variants = [token];
  const withPoint = token.replace(DECIMAL_COMMA_RE, "$1.$2");
  if (withPoint !== token) variants.push(withPoint);
  const withComma = token.replace(DECIMAL_POINT_RE, "$1,$2");
  if (withComma !== token) variants.push(withComma);
  return variants;
}

/** Drop combining marks; `ß` has no decomposition so it is spelled out. */
function stripDiacritics(value: string): string {
  return value.normalize("NFKD").replace(COMBINING_MARKS_RE, "").replace(SHARP_S_RE, "ss");
}

function expandUmlauts(value: string): string {
  return UMLAUT_EXPANSIONS.reduce(
    (folded, [pattern, replacement]) => folded.replace(pattern, replacement),
    value,
  );
}

/**
 * Both folded spellings of a string: marks-dropped and German-transliterated.
 * Returns one entry when they coincide (the overwhelmingly common case).
 */
export function foldedForms(value: string): string[] {
  const lower = normalizeQuery(value).normalize("NFC");
  if (!lower) return [];
  const stripped = stripDiacritics(lower);
  const expanded = stripDiacritics(expandUmlauts(lower));
  return expanded === stripped ? [stripped] : [stripped, expanded];
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.length > 0)));
}

/** Pre-expand a raw query string into matchable tokens. */
export function buildSearchTokens(query: string): SearchToken[] {
  return tokenizeQuery(query).map((token) => ({
    text: unique(foldedForms(token).flatMap(termVariants)),
    ident: identifierKey(token),
  }));
}

/**
 * Pre-fold one record. `textFields` are matched by substring, `identifierFields`
 * by punctuation-free substring so `#4471` finds `4471`.
 */
export function buildSearchHaystack(
  textFields: ReadonlyArray<string | null | undefined>,
  identifierFields: ReadonlyArray<string | number | null | undefined>,
): SearchHaystack {
  return {
    text: unique(
      textFields.flatMap((field) =>
        field == null ? [] : foldedForms(String(field)).flatMap(termVariants),
      ),
    ),
    ident: unique(
      identifierFields.map((field) => (field == null ? "" : identifierKey(String(field)))),
    ),
  };
}

function tokenMatches(haystack: SearchHaystack, token: SearchToken): boolean {
  for (const variant of token.text) {
    for (const field of haystack.text) {
      if (field.includes(variant)) return true;
    }
  }
  if (token.ident.length === 0) return false;
  for (const field of haystack.ident) {
    if (field.includes(token.ident)) return true;
  }
  return false;
}

/** AND across tokens, OR across fields — the server's multi-token semantics. */
export function haystackMatchesTokens(
  haystack: SearchHaystack,
  tokens: readonly SearchToken[],
): boolean {
  return tokens.every((token) => tokenMatches(haystack, token));
}
