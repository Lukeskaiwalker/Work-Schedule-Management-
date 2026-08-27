/**
 * Dependency-free fuzzy matching for customer search.
 *
 * Goal: find a customer even when the query is misspelled, partial, or the words
 * are in a different order — without pulling in a fuzzy-search library. Per query
 * token (whitespace-split) we take the best match against the haystack tokens
 * using exact/prefix/substring hits plus a bounded Levenshtein distance, so a
 * single dropped/transposed/wrong letter ("Schmit" → "Schmidt") still scores.
 * Every query token must contribute (AND semantics); the total is their sum,
 * with name-field matches weighted above address/email/contact matches.
 *
 * The phone number is the one field deliberately kept *out* of that fuzzy
 * path: edit distance on digit strings is meaningless — every number is within
 * two edits of a dozen unrelated ones — so phone is matched only as an exact
 * digit substring, using the same normalisation as the server.
 */

import { looksLikePhoneQuery, phoneDigits, phoneSearchKey, PHONE_MIN_DIGITS } from "./searchNormalize";

export type FuzzyCustomerFields = {
  name?: string | null;
  address?: string | null;
  email?: string | null;
  contact_person?: string | null;
  phone?: string | null;
};

const MAX_EDIT_DISTANCE = 2;

/** A phone hit is unambiguous, so it scores like an exact token match. */
const PHONE_MATCH_SCORE = 3;

/** Lowercase, strip diacritics (ü→u) and trim so "Muller" can match "Müller". */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function tokenize(value: string | null | undefined): string[] {
  return normalize(value ?? "")
    .split(/\s+/)
    .filter(Boolean);
}

/** Levenshtein distance, capped: returns `max + 1` as soon as it exceeds `max`. */
function boundedLevenshtein(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1; // cannot recover below max
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** Best match score of one query token against a set of haystack tokens (0 = none). */
function scoreToken(queryToken: string, haystackTokens: string[]): number {
  let best = 0;
  for (const ht of haystackTokens) {
    if (!ht) continue;
    if (ht === queryToken) return 3; // exact token — cannot beat this
    if (ht.startsWith(queryToken) || queryToken.startsWith(ht)) {
      best = Math.max(best, 2.5);
      continue;
    }
    if (ht.includes(queryToken)) {
      best = Math.max(best, 2);
      continue;
    }
    if (queryToken.length >= 3) {
      const maxDist = queryToken.length <= 4 ? 1 : MAX_EDIT_DISTANCE;
      const dist = boundedLevenshtein(queryToken, ht, maxDist);
      if (dist <= maxDist) best = Math.max(best, 1.5 - dist * 0.4);
    }
  }
  return best;
}

/**
 * Score one query fragment against a stored phone number (0 = no match).
 *
 * Both sides are reduced to digits, the fragment further to its national
 * significant form, so the stored prefix (`+49`, `0049`, `0`) is irrelevant.
 * Short fragments score nothing: "17" sits inside almost every number.
 */
function scorePhone(fragment: string, phone: string | null | undefined): number {
  if (!phone) return 0;
  if (phoneDigits(fragment).length < PHONE_MIN_DIGITS) return 0;
  return phoneDigits(phone).includes(phoneSearchKey(fragment)) ? PHONE_MATCH_SCORE : 0;
}

/**
 * Score a customer against the query. Returns 0 when any query token matches
 * nothing (AND semantics); otherwise the summed, name-weighted token scores.
 */
export function scoreCustomerMatch(query: string, fields: FuzzyCustomerFields): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;

  const nameTokens = tokenize(fields.name);
  const otherTokens = [
    ...tokenize(fields.address),
    ...tokenize(fields.email),
    ...tokenize(fields.contact_person),
  ];

  let total = 0;
  for (const qt of queryTokens) {
    const tokenScore = Math.max(
      scoreToken(qt, nameTokens) * 1.5,
      scoreToken(qt, otherTokens),
      scorePhone(qt, fields.phone),
    );
    if (tokenScore <= 0) {
      // Every query token must match some field — except when the query is a
      // phone number typed with spaces in it ("+49 171 1234567"), where the
      // fragments are not words and "+49" carries too few digits to match on
      // its own. Such a query has no text intent, so fall back to matching it
      // unsplit, exactly as the server does.
      return looksLikePhoneQuery(query) ? scorePhone(query, fields.phone) : 0;
    }
    total += tokenScore;
  }
  return total;
}

/** Filter + rank customers by fuzzy score, best first, capped at `limit`. */
export function fuzzyFilterCustomers<T extends FuzzyCustomerFields>(
  customers: T[],
  query: string,
  limit: number,
): T[] {
  if (!query.trim()) return customers.slice(0, limit);
  return customers
    .map((row) => ({ row, score: scoreCustomerMatch(query, row) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || (a.row.name ?? "").localeCompare(b.row.name ?? ""))
    .slice(0, limit)
    .map((entry) => entry.row);
}
