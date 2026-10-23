/**
 * What the drop note says (docs/PANEL_ENCLOSURE_R2.md §6.5, §13) — pure,
 * from the board before and after a change:
 *
 *   1. what moved: "{bmk} verschoben: {title}, Platz {i}." (a group head:
 *      "{bmk} mit {n} Stromkreisen verschoben: …"); a strip "{X} verschoben:
 *      Feld {n} · Hutschiene {r}."; a finding's action what it did;
 *   2. which circuits now hang off another Schutzgerät — one by name with
 *      its old head, several summed up (three by name, "und {k} weitere");
 *   3. what it did to the WAGO terminals (cabinet boards): renumbered strips
 *      ("— Beschriftung neu drucken"), a strip now in another field, a strip
 *      that lost or found its place;
 *   4. a circuit with "Reihenklemme" now in a zone without WAGO (R3).
 *
 * Heads are named as the terminal findings name them (`group_head_label`):
 * the BMK, else the short name, "Einspeisung" for none. Terminals come from
 * `boardTerminals` + `placeTerminals`, memoised by document identity, so the
 * page's own placement of the board is reused.
 */
import { feedChanges, dragGroup } from "../../../utils/enclosureOpsDrag";
import type { CatalogIndex } from "../../../utils/enclosureCatalog";
import { zoneLabel } from "../../../utils/enclosureLayout";
import { linkedRails, placeTerminals } from "../../../utils/enclosureTerminals";
import { headLabel, joinAnd } from "../../../utils/enclosureTerminalSuggest";
import { catalogEntry } from "../../../utils/schaltplanDevices";
import { findDevice } from "../../../utils/schaltplanTopologyCore";
import type { TerminalSuggestion } from "../../../types/panelEnclosure";
import type { PanelDocument } from "../../../types/schaltplan";

export const UNDONE_TEXT = "Verschieben rückgängig gemacht.";
const MAX_LINES = 5;
const NAMED_CHANGES = 3;

/** At most five lines; more are cut with "…". */
export function capNoteLines(lines: readonly string[]): string[] {
  return lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), "…"] : [...lines];
}

/** A device by its BMK, else its short name ("LS"). */
function bmk(doc: PanelDocument, id: string): string {
  const device = findDevice(doc, id);
  if (!device) return id;
  return device.designation.trim() || catalogEntry(device.kind).short;
}

/** A head as a finding names it; "" is the Einspeisung. Names come from the board after the drop, then before it. */
function headName(after: PanelDocument, before: PanelDocument, id: string): string {
  if (id === "") return "Einspeisung";
  return findDevice(after, id) ? bmk(after, id) : bmk(before, id);
}

function stromkreise(count: number): string {
  return count === 1 ? "1 Stromkreis" : `${count} Stromkreisen`;
}

function movedLine(before: PanelDocument, after: PanelDocument, index: CatalogIndex, deviceId: string): string | null {
  const row = after.rows.find((candidate) => candidate.devices.some((device) => device.id === deviceId));
  if (!row) return null;
  const place = row.devices.findIndex((device) => device.id === deviceId) + 1;
  const followers = dragGroup(before, index, deviceId).length - 1;
  const who = followers > 0 ? `${bmk(after, deviceId)} mit ${stromkreise(followers)}` : bmk(after, deviceId);
  return `${who} verschoben: ${row.label}, Platz ${place}.`;
}

function feedLine(before: PanelDocument, after: PanelDocument): string | null {
  const changes = feedChanges(before, after);
  if (changes.length === 0) return null;
  if (changes.length === 1) {
    const [change] = changes;
    return `${bmk(after, change.deviceId)} hängt jetzt an ${headName(after, before, change.to)} (vorher ${headName(after, before, change.from)}).`;
  }
  const named = changes
    .slice(0, NAMED_CHANGES)
    .map((change) => `${bmk(after, change.deviceId)} ${headName(after, before, change.from)} → ${headName(after, before, change.to)}`);
  const rest = changes.length > NAMED_CHANGES ? ` und ${changes.length - NAMED_CHANGES} weitere` : "";
  return `${changes.length} Stromkreise hängen jetzt an einem anderen Schutzgerät: ${named.join(", ")}${rest}.`;
}

// ── Terminals ────────────────────────────────────────────────────────────────

interface StripState {
  xLabel: string;
  stripNo: number;
  field: number;
  placed: boolean;
  /** 0-based terminal rail, -1 without place. */
  rail: number;
}

/** strip id → where the placement has it; empty without a cabinet. */
function stripStates(doc: PanelDocument, index: CatalogIndex): Map<string, StripState> {
  const out = new Map<string, StripState>();
  if (!doc.enclosure) return out;
  for (const field of placeTerminals(doc, index).fields) {
    field.rails.forEach((rail, at) => {
      for (const strip of rail.strips) out.set(strip.stripId, { xLabel: strip.xLabel, stripNo: strip.stripNo, field: field.field, placed: true, rail: at });
    });
    for (const strip of field.unplaced) {
      out.set(strip.stripId, { xLabel: strip.xLabel, stripNo: Number.MAX_SAFE_INTEGER, field: field.field, placed: false, rail: -1 });
    }
  }
  return out;
}

function renumberLine(old: ReadonlyMap<string, StripState>, now: ReadonlyMap<string, StripState>): string | null {
  const renamed = [...old]
    .filter(([id, state]) => now.has(id) && now.get(id)!.xLabel !== state.xLabel)
    .sort(([, a], [, b]) => a.stripNo - b.stripNo || (a.xLabel < b.xLabel ? -1 : 1))
    .map(([id, state]) => `${state.xLabel} → ${now.get(id)!.xLabel}`);
  if (renamed.length === 0) return null;
  const rest = renamed.length > NAMED_CHANGES ? ` und ${renamed.length - NAMED_CHANGES} weitere` : "";
  return `Klemmen neu nummeriert: ${renamed.slice(0, NAMED_CHANGES).join(", ")}${rest} — Beschriftung neu drucken.`;
}

/** Renumbering, field changes, lost and found places: what a change did to the WAGO terminals. */
export function terminalLines(before: PanelDocument, after: PanelDocument, index: CatalogIndex): string[] {
  if (!before.enclosure && !after.enclosure) return [];
  const old = stripStates(before, index);
  const now = stripStates(after, index);
  const lines: string[] = [];
  const renumbered = renumberLine(old, now);
  if (renumbered) lines.push(renumbered);
  const ordered = [...now].sort(([, a], [, b]) => a.field - b.field || a.stripNo - b.stripNo);
  for (const [id, state] of ordered) {
    const was = old.get(id);
    if (!was) continue;
    const field = state.field + 1;
    if (was.field !== state.field) lines.push(`${state.xLabel} jetzt in Feld ${field}.`);
    if (was.placed && !state.placed) lines.push(`${state.xLabel} hat keinen Platz mehr in Feld ${field}.`);
    if (!was.placed && state.placed) lines.push(`${state.xLabel} hat jetzt Platz in Feld ${field}.`);
  }
  return lines;
}

/** R3: a moved circuit with "Reihenklemme" that now sits in a zone without WAGO. */
function zoneLines(before: PanelDocument, after: PanelDocument, index: CatalogIndex, deviceIds: readonly string[]): string[] {
  if (!after.enclosure) return [];
  const rails = linkedRails(after, index);
  const skipped = new Set(placeTerminals(after, index).skip);
  const wasSkipped = new Set(before.enclosure ? placeTerminals(before, index).skip : []);
  const lines: string[] = [];
  for (const id of deviceIds) {
    const device = findDevice(after, id);
    if (!device?.terminal_block || !skipped.has(id) || wasSkipped.has(id)) continue;
    const row = after.rows.find((candidate) => candidate.devices.some((entry) => entry.id === id));
    const zone = row ? rails.get(row.id)?.zone : undefined;
    if (zone) lines.push(`Im ${zoneLabel(zone)} keine Reihenklemme für ${bmk(after, id)}.`);
  }
  return lines;
}

const present = (lines: readonly (string | null)[]): string[] => lines.filter((line): line is string => line !== null);

/** The note's lines for a device drop (drag or RailPicker). */
export function describeDrop(before: PanelDocument, after: PanelDocument, index: CatalogIndex, deviceId: string): string[] {
  const moved = dragGroup(before, index, deviceId);
  return capNoteLines([
    ...present([movedLine(before, after, index, deviceId), feedLine(before, after)]),
    ...terminalLines(before, after, index),
    ...zoneLines(before, after, index, moved),
  ]);
}

/** The note's lines for a strip moved in the close-up or the drawing. */
export function describeStripMove(before: PanelDocument, after: PanelDocument, index: CatalogIndex, stripId: string): string[] {
  const state = stripStates(after, index).get(stripId);
  const first = state && state.placed ? `${state.xLabel} verschoben: Feld ${state.field + 1} · Hutschiene ${state.rail + 1}.` : null;
  return capNoteLines([...present([first]), ...terminalLines(before, after, index)]);
}

function actionLine(after: PanelDocument, before: PanelDocument, suggestion: TerminalSuggestion): string {
  switch (suggestion.kind) {
    case "relink_rows": {
      const titles = joinAnd(suggestion.moves.map((move) => move.target.title));
      return `Vorschlag ausgeführt: ${suggestion.moves.length === 1 ? "Reihe" : "Reihen"} auf ${titles} umgehängt.`;
    }
    case "move_group": {
      const head = findDevice(after, suggestion.headId) ?? findDevice(before, suggestion.headId);
      const titles = joinAnd(suggestion.targets.map((target) => target.title));
      return `Vorschlag ausgeführt: ${headLabel(head)} mit ${stromkreise(suggestion.deviceIds.length - 1)} nach ${titles} verschoben.`;
    }
    case "reset_order":
      return `Reihenfolge der Klemmleisten in Feld ${suggestion.field + 1} zurückgesetzt.`;
    case "remove_placeholders": {
      const count = suggestion.deviceIds.length;
      return `${count} ${count === 1 ? "Platzhalter-Reihenklemme" : "Platzhalter-Reihenklemmen"} entfernt.`;
    }
  }
}

/** The note's lines for a finding's action ("Vorschlag ausführen", "Reihenfolge zurücksetzen", "Platzhalter entfernen"). */
export function describeAction(before: PanelDocument, after: PanelDocument, index: CatalogIndex, suggestion: TerminalSuggestion): string[] {
  return capNoteLines([actionLine(after, before, suggestion), ...present([feedLine(before, after)]), ...terminalLines(before, after, index)]);
}
