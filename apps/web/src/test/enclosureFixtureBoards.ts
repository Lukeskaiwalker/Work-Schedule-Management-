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
import type { EnclosureCatalog, EnclosureScene } from "../types/panelEnclosure";
import type { PanelDocument, PanelFinding } from "../types/schaltplan";

export interface FixtureBoard {
  document: PanelDocument;
  order: string[];
  scene_open: EnclosureScene | null;
  scene_closed: EnclosureScene | null;
  findings: PanelFinding[];
}

const raw = fixtures as unknown as { catalog: EnclosureCatalog; boards: Record<string, FixtureBoard> };

export const FIXTURE_CATALOG = raw.catalog;
export const FIXTURE_INDEX = catalogIndex(raw.catalog);
export const FIXTURE_BOARDS: Readonly<Record<string, FixtureBoard>> = raw.boards;
export const BOARD_NAMES = Object.keys(raw.boards);

/** A deep copy, so a test can freeze or edit a board without touching the shared import. */
export function boardDocument(name: string): PanelDocument {
  return JSON.parse(JSON.stringify(raw.boards[name].document)) as PanelDocument;
}
