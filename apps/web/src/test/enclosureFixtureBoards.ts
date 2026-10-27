/**
 * The shared cabinet fixture, typed (docs/PANEL_ENCLOSURE.md §14).
 *
 * `fixtures/enclosureFixtures.json` is written by
 * `apps/api/scripts/write_enclosure_fixtures.py` from the Python twins of
 * the layout, the geometry and the rules: per board the input document and
 * exactly what Python answers. The TS parity tests demand the same, key for
 * key. A red parity test means one side changed; fix the twin, or — after a
 * deliberate change — re-run the script and commit the JSON with it.
 */
import fixtures from "./fixtures/enclosureFixtures.json";
import { catalogIndex } from "../utils/enclosureCatalog";
import type {
  CabinetPrep,
  CableSection,
  ControlBlock,
  ControlBlockPlacement,
  EnclosureCatalog,
  EnclosureScene,
  PrepOverrides,
  TerminalCloseup,
  TerminalPlacement,
  TerminalSuggestion,
} from "../types/panelEnclosure";
import type { PanelDocument, PanelFinding } from "../types/schaltplan";

export interface FixtureBoard {
  document: PanelDocument;
  order: string[];
  scene_open: EnclosureScene | null;
  scene_closed: EnclosureScene | null;
  findings: PanelFinding[];
  /** Round 2 (docs/PANEL_ENCLOSURE_R2.md §14.1): ids of the devices that get no terminal, sorted. */
  terminal_skip: string[];
  terminal_placement: TerminalPlacement;
  /** Round 2 (§7.1, §4.2): the close-up and the suggestion pass, as Python answers them. */
  terminal_closeup: TerminalCloseup[];
  terminal_suggestions: TerminalSuggestion[];
  /** Round 4 (docs/PANEL_ENCLOSURE_R4.md §10): `place_control_block` and `cabinet_prep`, as Python answers them. */
  control_block: ControlBlockPlacement | null;
  prep: CabinetPrep | null;
}

/** One row of a parser table (R4 §2.1, §2.2, §3.5): what Python's parser answered for `input`. */
export interface ParseCase<O> {
  input: unknown;
  output: O;
}

/** The round-4 parser tables both twins run. */
export interface FixtureParseTables {
  control_block_parse: ParseCase<ControlBlock | null>[];
  prep_parse: ParseCase<PrepOverrides | null>[];
  infeed_parse: ParseCase<CableSection>[];
  fuse_parse: ParseCase<number | null>[];
  /** `rating` ⇄ `ratingValue`: ASCII digits only. */
  rating_parse: ParseCase<number | null>[];
  /** `text` ⇄ `edgeTrimmed`: one explicit edge set. */
  edge_trim: ParseCase<string>[];
  /** R4 §9.1, written once the printing slice's `control_strip_size` exists; absent before. */
  control_strip_size?: { labels: string[]; size: number }[];
}

/** The constants Python placed with, echoed so a change shows up in one diff (§3.5). */
export interface FixtureConstants {
  TERMINAL_RAIL_USABLE_MM: number;
  TERMINAL_RAIL_USABLE_VERIFIED: boolean;
}

const raw = fixtures as unknown as FixtureParseTables & {
  catalog: EnclosureCatalog;
  constants: FixtureConstants;
  boards: Record<string, FixtureBoard>;
};

export const FIXTURE_CATALOG = raw.catalog;
export const FIXTURE_CONSTANTS = raw.constants;
export const FIXTURE_INDEX = catalogIndex(raw.catalog);
export const FIXTURE_BOARDS: Readonly<Record<string, FixtureBoard>> = raw.boards;
export const BOARD_NAMES = Object.keys(raw.boards);
export const FIXTURE_TABLES: FixtureParseTables = {
  control_block_parse: raw.control_block_parse,
  prep_parse: raw.prep_parse,
  infeed_parse: raw.infeed_parse,
  fuse_parse: raw.fuse_parse,
  rating_parse: raw.rating_parse,
  edge_trim: raw.edge_trim,
  control_strip_size: raw.control_strip_size,
};

/** A deep copy, so a test can freeze or edit a board without touching the shared import. */
export function boardDocument(name: string): PanelDocument {
  return JSON.parse(JSON.stringify(raw.boards[name].document)) as PanelDocument;
}
