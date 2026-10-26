/**
 * The module picker's search (docs/PANEL_ENCLOSURE_R4.md §8.1): pure, so
 * the sheet only wires it to the box.
 *
 * Matching is the app's one list search (`utils/searchNormalize.ts`):
 * "zaehler", "zahler" and "Zähler" find each other, "zu-37" finds ZU37KS,
 * every word typed must match. A module is found by what the fitter reads
 * on the kit or the shelf: its name, its family ("Zählerfeld eHZ"), the
 * stock article's name and the zones it holds (NAR, AAR, RfZ, APZ, SAS,
 * VF) as text; its code, article number, the stock article's number and
 * internal code as identifiers.
 *
 * The search only filters what the picker model already built: sections
 * and the order inside them stay, a section left empty goes. Modules for
 * the other field height stay hidden, but a search counts the ones that
 * match, so a kit typed by its code never just "vanishes".
 */
import { FAMILY_LABELS } from "../../../utils/enclosureCatalog";
import {
  buildSearchHaystack,
  buildSearchTokens,
  haystackMatchesTokens,
  type SearchHaystack,
  type SearchToken,
} from "../../../utils/searchNormalize";
import type { ModuleSpec, UncataloguedArticle, ZoneType } from "../../../types/panelEnclosure";
import type { PanelMaterialArticle } from "../../../types/schaltplan";

/** The zone types a fitter names a module by, spelled as on the kit. */
const SEARCHABLE_ZONES: Readonly<Partial<Record<ZoneType, string>>> = {
  NAR: "NAR",
  AAR: "AAR",
  RFZ: "RfZ",
  APZ: "APZ",
  SAS: "SAS",
  VF: "VF",
};

export interface Searchable {
  readonly haystack: SearchHaystack;
}

/** A module hidden for its field height: only counted, never listed. */
export interface HiddenModule extends Searchable {
  readonly height: number;
}

export interface HiddenCount {
  height: number;
  count: number;
}

export interface SearchSection<K, T> {
  key: K;
  items: readonly T[];
}

export interface PickerSearchInput<K, T extends Searchable, U extends Searchable> {
  sections: readonly SearchSection<K, T>[];
  hidden: readonly HiddenModule[];
  /** Shelf articles the catalogue lacks — [] for everyone who does not see them. */
  shelf: readonly U[];
}

export interface PickerSearchView<K, T, U> {
  /** A query with at least one word; whitespace alone searches nothing. */
  searching: boolean;
  sections: SearchSection<K, T>[];
  hidden: HiddenCount[];
  shelf: U[];
  /** Every visible item, refused ones included; hidden heights not. */
  count: number;
}

function zoneNames(spec: ModuleSpec): string[] {
  return spec.zones.flatMap((zone) => {
    const name = SEARCHABLE_ZONES[zone.type];
    return name ? [name] : [];
  });
}

export function moduleHaystack(spec: ModuleSpec, article: PanelMaterialArticle | null): SearchHaystack {
  return buildSearchHaystack(
    [spec.name, FAMILY_LABELS[spec.family], article?.item_name, ...zoneNames(spec)],
    [spec.code, spec.article_no, article?.article_number, article?.internal_code, spec.name],
  );
}

export function uncataloguedHaystack(item: UncataloguedArticle): SearchHaystack {
  return buildSearchHaystack([item.article.item_name], [item.article.article_number, item.code_guess, item.article.item_name]);
}

const matches = (entry: Searchable, tokens: readonly SearchToken[]) => haystackMatchesTokens(entry.haystack, tokens);

/** The matching items of each section, sections in their order; empty ones dropped. */
export function filterSections<K, T extends Searchable>(sections: readonly SearchSection<K, T>[], tokens: readonly SearchToken[]): SearchSection<K, T>[] {
  return sections
    .map((section) => ({ key: section.key, items: section.items.filter((entry) => matches(entry, tokens)) }))
    .filter((section) => section.items.length > 0);
}

/** Matching hidden modules per field height, lowest height first; a height without a match is left out. */
export function countHidden(hidden: readonly HiddenModule[], tokens: readonly SearchToken[]): HiddenCount[] {
  const counts = new Map<number, number>();
  for (const entry of hidden) {
    if (matches(entry, tokens)) counts.set(entry.height, (counts.get(entry.height) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => a - b).map(([height, count]) => ({ height, count }));
}

/** Without a query the round-1 line (PANEL_ENCLOSURE.md §11); while searching, the matching ones. */
export function hiddenHint({ height, count }: HiddenCount, searching: boolean): string {
  if (!searching) return `${count} Module für ${height} mm Felder ausgeblendet`;
  return count === 1 ? `1 passendes Modul für ${height}-mm-Felder ausgeblendet` : `${count} passende Module für ${height}-mm-Felder ausgeblendet`;
}

/** The status line under the box: empty without a query. */
export function searchStatus(searching: boolean, count: number): string {
  if (!searching) return "";
  return count === 0 ? "Kein Treffer" : `${count} Treffer`;
}

export const noMatchText = (query: string) => `Kein Modul gefunden für „${query.trim()}“.`;

export function searchPicker<K, T extends Searchable, U extends Searchable>(
  input: PickerSearchInput<K, T, U>,
  query: string,
): PickerSearchView<K, T, U> {
  const tokens = buildSearchTokens(query);
  const sections = filterSections(input.sections, tokens);
  const shelf = input.shelf.filter((entry) => matches(entry, tokens));
  const count = sections.reduce((total, section) => total + section.items.length, shelf.length);
  return { searching: tokens.length > 0, sections, hidden: countHidden(input.hidden, tokens), shelf, count };
}
