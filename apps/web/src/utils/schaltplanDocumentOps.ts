/**
 * Document operations that build several devices at once.
 *
 * `SchaltplanPage` owns the one-device operations (add, patch, move, remove)
 * because they are a line each. Duplicating and rail templates are not: they
 * have to *number* what they create, and the numbering has rules an
 * electrician will check against the printed BMK strip — a counted-up BMK
 * must be free, the Stromkreis-Nr. must be the next unused one, and a
 * template rail must land on the same numbering a hand-built one would.
 * Those rules live here, pure and tested, and the page only calls them.
 *
 * Everything returns new objects; the document passed in is never touched.
 */
import { catalogEntry, makeDevice, newId, nextCircuitNumber, rowUsedSlots } from "./schaltplanDevices";
import { allDevices, isCircuitDevice } from "./schaltplanTopology";
import type { DeviceKind, PanelDevice, PanelDocument, PanelRow, PhaseLabel } from "../types/schaltplan";

/** Width of a rail that was not sized by hand — the classic 12-TE Reihe. */
export const DEFAULT_ROW_SLOTS = 12;

/** Load balancing by habit: consecutive breakers rotate through the phases. */
const PHASE_ROTATION: readonly PhaseLabel[] = ["L1", "L2", "L3"];

/** The last run of digits in a designation, e.g. the "3" of "F1.3" or "-F3". */
const LAST_NUMBER = /(\d+)(?!.*\d)/;

/**
 * Count a Betriebsmittelkennzeichen up by one: "F1.3" → "F1.4", "-F3" →
 * "-F4", "F09" → "F10" (padding survives). A designation without a number
 * cannot be counted and comes back unchanged — the caller decides what an
 * uncountable BMK means.
 */
export function bumpDesignation(designation: string): string {
  const match = LAST_NUMBER.exec(designation);
  if (!match || match.index === undefined) return designation;
  const digits = match[1];
  const next = String(Number.parseInt(digits, 10) + 1).padStart(digits.length, "0");
  return designation.slice(0, match.index) + next + designation.slice(match.index + digits.length);
}

/** Every BMK in use, upper-cased so "f1.1" and "F1.1" count as the same label. */
export function takenDesignations(document: PanelDocument): Set<string> {
  const taken = new Set<string>();
  for (const device of allDevices(document)) {
    const designation = device.designation.trim();
    if (designation) taken.add(designation.toUpperCase());
  }
  return taken;
}

/** Upper bound on count-up attempts; beyond it the document is nonsense anyway. */
const MAX_BUMPS = 1000;

/**
 * The next free designation after `seed`. An empty or unnumbered seed yields
 * "" rather than a verbatim copy: two devices carrying the same BMK would
 * print two identical labels, and a blank tile is the honest state.
 */
export function nextDesignation(seed: string, taken: ReadonlySet<string>): string {
  const start = seed.trim();
  if (!LAST_NUMBER.test(start)) return "";
  let candidate = bumpDesignation(start);
  for (let attempt = 0; attempt < MAX_BUMPS && taken.has(candidate.toUpperCase()); attempt += 1) {
    candidate = bumpDesignation(candidate);
  }
  return candidate;
}

/** First unused designation at or after `candidate` ("F1" → "F1" if free, else "F2", …). */
function firstFree(candidate: string, taken: ReadonlySet<string>): string {
  return taken.has(candidate.toUpperCase()) ? nextDesignation(candidate, taken) : candidate;
}

/**
 * Copy a device into the slot right after it. The copy keeps every electrical
 * field (rating, cable, phase, feed override, even the label — the user is
 * copying, not resetting) and gets its own numbering: the next free BMK and,
 * for anything that occupies a Stromkreis line, the next unused number.
 */
export function duplicateDevice(
  document: PanelDocument,
  deviceId: string,
): { document: PanelDocument; deviceId: string | null } {
  const rowIndex = document.rows.findIndex((row) => row.devices.some((device) => device.id === deviceId));
  if (rowIndex < 0) return { document, deviceId: null };
  const row = document.rows[rowIndex];
  const index = row.devices.findIndex((device) => device.id === deviceId);
  const original = row.devices[index];

  const numbered = original.circuit.trim() !== "" || original.kind === "mcb" || original.kind === "rcbo";
  const copy: PanelDevice = {
    ...original,
    id: newId("dev"),
    designation: nextDesignation(original.designation, takenDesignations(document)),
    circuit: numbered && isCircuitDevice(original) ? nextCircuitNumber(document) : "",
  };

  const devices = [...row.devices.slice(0, index + 1), copy, ...row.devices.slice(index + 1)];
  return {
    document: {
      ...document,
      rows: document.rows.map((candidate, position) =>
        position === rowIndex ? { ...candidate, devices } : candidate,
      ),
    },
    deviceId: copy.id,
  };
}

// ── Rail templates ───────────────────────────────────────────────────────────

export type RowTemplateId = "empty" | "rcd-6mcb" | "rcd-8mcb" | "mcb-12";

export interface RowTemplate {
  id: RowTemplateId;
  label: string;
  /** One line under the label: what lands on the rail and how wide it is. */
  hint: string;
  kinds: readonly DeviceKind[];
}

const times = (count: number, kind: DeviceKind): DeviceKind[] => Array.from({ length: count }, () => kind);

export const ROW_TEMPLATES: readonly RowTemplate[] = [
  { id: "empty", label: "Leere Reihe", hint: "Geräte einzeln hinzufügen", kinds: [] },
  { id: "rcd-6mcb", label: "1 FI + 6 LS", hint: "FI 40 A / 30 mA, sechs LS B16 · 10 TE", kinds: ["rcd", ...times(6, "mcb")] },
  { id: "rcd-8mcb", label: "1 FI + 8 LS", hint: "FI 40 A / 30 mA, acht LS B16 · volle 12 TE", kinds: ["rcd", ...times(8, "mcb")] },
  { id: "mcb-12", label: "12 LS", hint: "ohne eigenen FI — hängt am FI der Reihe davor · 12 TE", kinds: times(12, "mcb") },
];

/**
 * Where a rail without its own FI continues counting: after the last
 * designated device in physical order. A breaker continues its own number
 * ("F1.3" → "F1.4"); an F-numbered group that has no breakers yet opens its
 * sub-numbering ("F1" → "F1.1"); a group named differently (a Hauptschalter
 * "Q1") or an empty board starts at "F1".
 */
function continuationSeed(document: PanelDocument): string {
  let seed = "F0";
  for (const device of allDevices(document)) {
    const designation = device.designation.trim();
    if (!designation) continue;
    if (catalogEntry(device.kind).group) {
      seed = /^F\d/i.test(designation) ? `${designation}.0` : "F0";
    } else if (isCircuitDevice(device)) {
      seed = designation;
    }
  }
  return seed;
}

/**
 * Build a rail from a template, numbered as if its devices had been added by
 * hand one after another: an FI takes the first free "F<n>", its breakers
 * "F<n>.1" onwards; a rail without an FI continues counting from the last
 * circuit on the board (or starts at "F1"). Stromkreis-Nrn. run on from the
 * highest one in use, and breakers rotate through L1/L2/L3.
 */
export function rowFromTemplate(
  document: PanelDocument,
  templateId: string,
  options: { slots?: number } = {},
): PanelRow {
  const template = ROW_TEMPLATES.find((entry) => entry.id === templateId);
  const kinds = template?.kinds ?? [];
  const taken = new Set(takenDesignations(document));
  const hasGroup = kinds.some((kind) => catalogEntry(kind).group);

  let previousDesignation = hasGroup ? "" : continuationSeed(document);
  let circuit = Number.parseInt(nextCircuitNumber(document), 10);
  let breakerIndex = 0;

  const devices = kinds.map((kind): PanelDevice => {
    const entry = catalogEntry(kind);
    if (entry.group) {
      const designation = firstFree("F1", taken);
      taken.add(designation.toUpperCase());
      previousDesignation = `${designation}.0`;
      return makeDevice(kind, { designation, rating: entry.ratingHint, phase: "L1-L3" });
    }
    const designation = nextDesignation(previousDesignation, taken);
    if (designation) taken.add(designation.toUpperCase());
    previousDesignation = designation || previousDesignation;
    const phase = PHASE_ROTATION[breakerIndex % PHASE_ROTATION.length];
    breakerIndex += 1;
    const device = makeDevice(kind, {
      designation,
      rating: entry.ratingHint,
      phase,
      circuit: entry.circuit ? String(circuit) : "",
    });
    if (entry.circuit) circuit += 1;
    return device;
  });

  const row: PanelRow = {
    id: newId("row"),
    label: `Reihe ${document.rows.length + 1}`,
    slots: options.slots ?? DEFAULT_ROW_SLOTS,
    devices,
  };
  return { ...row, slots: Math.max(row.slots, rowUsedSlots(row)) };
}
