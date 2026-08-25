/**
 * Device catalogue for the Verteilerplan editor.
 *
 * Mirrors `DEVICE_CATALOG` in `apps/api/app/services/schaltplan_layout.py`.
 * The backend serves the same table from `GET /schaltplan/devices`; this copy
 * exists so the palette paints instantly on a cold tablet, and the page
 * reconciles against the server list once it arrives. Adding a kind means
 * touching both files (and `types/schaltplan.ts`).
 */

import type { DeviceKind, DeviceSymbol, PanelDevice, PanelDocument } from "../types/schaltplan";

export interface DeviceCatalogEntry {
  kind: DeviceKind;
  /** German name shown in the palette. */
  label: string;
  /** Compact name used on the diagram and in the legend's "Gerät" column. */
  short: string;
  te: number;
  poles: number;
  /** Opens a protection group — everything after it hangs off it. */
  group: boolean;
  /** Occupies a line in the Stromkreisliste. */
  circuit: boolean;
  symbol: DeviceSymbol;
  ratingHint: string;
  /** Palette grouping so the picker is scannable rather than a wall of 19. */
  section: "schutz" | "abgang" | "funktion" | "sonstiges";
}

export const DEVICE_CATALOG: Record<DeviceKind, DeviceCatalogEntry> = {
  hauptschalter: { kind: "hauptschalter", label: "Hauptschalter", short: "HS", te: 3, poles: 3, group: true, circuit: false, symbol: "switch", ratingHint: "63 A", section: "schutz" },
  sls: { kind: "sls", label: "SLS-Schalter (selektiv)", short: "SLS", te: 3, poles: 3, group: true, circuit: false, symbol: "sls", ratingHint: "E35", section: "schutz" },
  rcd: { kind: "rcd", label: "FI-Schutzschalter (RCD)", short: "FI", te: 4, poles: 4, group: true, circuit: false, symbol: "rcd", ratingHint: "40 A", section: "schutz" },
  rcbo: { kind: "rcbo", label: "FI/LS kombiniert", short: "FI/LS", te: 2, poles: 2, group: false, circuit: true, symbol: "rcbo", ratingHint: "B16", section: "abgang" },
  mcb: { kind: "mcb", label: "Leitungsschutzschalter", short: "LS", te: 1, poles: 1, group: false, circuit: true, symbol: "mcb", ratingHint: "B16", section: "abgang" },
  fuse: { kind: "fuse", label: "Sicherung (NH / Neozed)", short: "Si", te: 3, poles: 3, group: false, circuit: true, symbol: "fuse", ratingHint: "35 A", section: "abgang" },
  spd: { kind: "spd", label: "Überspannungsschutz", short: "SPD", te: 4, poles: 4, group: false, circuit: false, symbol: "spd", ratingHint: "Typ 2", section: "schutz" },
  meter: { kind: "meter", label: "Zähler / eHZ", short: "kWh", te: 6, poles: 3, group: false, circuit: false, symbol: "meter", ratingHint: "", section: "sonstiges" },
  contactor: { kind: "contactor", label: "Installationsschütz", short: "Schütz", te: 2, poles: 4, group: false, circuit: true, symbol: "contactor", ratingHint: "20 A", section: "funktion" },
  impulse: { kind: "impulse", label: "Stromstoßschalter", short: "Stromstoß", te: 1, poles: 1, group: false, circuit: true, symbol: "relay", ratingHint: "16 A", section: "funktion" },
  timer: { kind: "timer", label: "Treppenlicht-/Zeitrelais", short: "Zeit", te: 1, poles: 1, group: false, circuit: true, symbol: "relay", ratingHint: "16 A", section: "funktion" },
  bell_transformer: { kind: "bell_transformer", label: "Klingeltrafo", short: "Trafo", te: 2, poles: 1, group: false, circuit: true, symbol: "transformer", ratingHint: "8 V", section: "funktion" },
  power_supply: { kind: "power_supply", label: "Netzteil / Spannungsversorgung", short: "NT", te: 4, poles: 1, group: false, circuit: true, symbol: "transformer", ratingHint: "24 V DC", section: "funktion" },
  knx_actuator: { kind: "knx_actuator", label: "KNX-Aktor", short: "KNX", te: 4, poles: 1, group: false, circuit: true, symbol: "bus", ratingHint: "8-fach", section: "funktion" },
  wallbox: { kind: "wallbox", label: "Wallbox-Abgang", short: "Wallbox", te: 3, poles: 3, group: false, circuit: true, symbol: "wallbox", ratingHint: "B32", section: "abgang" },
  pv: { kind: "pv", label: "PV-Einspeisung", short: "PV", te: 3, poles: 3, group: false, circuit: true, symbol: "pv", ratingHint: "B25", section: "abgang" },
  sub_feed: { kind: "sub_feed", label: "Abgang Unterverteiler", short: "→ UV", te: 3, poles: 3, group: false, circuit: true, symbol: "subfeed", ratingHint: "B40", section: "abgang" },
  terminal: { kind: "terminal", label: "Reihenklemme N/PE", short: "Klemme", te: 1, poles: 1, group: false, circuit: false, symbol: "terminal", ratingHint: "", section: "sonstiges" },
  blank: { kind: "blank", label: "Blindabdeckung", short: "—", te: 1, poles: 1, group: false, circuit: false, symbol: "blank", ratingHint: "", section: "sonstiges" },
};

export const PALETTE_SECTIONS: { key: DeviceCatalogEntry["section"]; label: string }[] = [
  { key: "schutz", label: "Schutz & Einspeisung" },
  { key: "abgang", label: "Abgänge / Stromkreise" },
  { key: "funktion", label: "Funktionsgeräte" },
  { key: "sonstiges", label: "Sonstiges" },
];

export function catalogEntry(kind: string): DeviceCatalogEntry {
  return DEVICE_CATALOG[kind as DeviceKind] ?? DEVICE_CATALOG.blank;
}

export const PANEL_TYPE_LABELS: Record<string, string> = {
  main: "Hauptverteiler",
  sub: "Unterverteiler",
  meter: "Zählerplatz",
};

export const PHASE_OPTIONS = ["-", "L1", "L2", "L3", "L1-L3", "L1/N", "N"] as const;
export const RCD_TYPE_OPTIONS = ["", "AC", "A", "F", "B", "B+"] as const;
export const SUPPLY_SYSTEMS = ["TN-S", "TN-C-S", "TT", "IT"] as const;

/** Common ratings, offered as chips so nobody types "B16" on a phone keyboard. */
export const RATING_SUGGESTIONS: Record<string, string[]> = {
  mcb: ["B10", "B13", "B16", "B20", "B25", "C16", "C20"],
  rcbo: ["B10", "B16", "B20", "C16"],
  rcd: ["25 A", "40 A", "63 A"],
  hauptschalter: ["40 A", "63 A", "80 A"],
  sls: ["E25", "E35", "E50"],
  wallbox: ["B16", "B20", "B32"],
  sub_feed: ["B25", "B32", "B40", "B50"],
};

export const RESIDUAL_CURRENT_SUGGESTIONS = ["10 mA", "30 mA", "100 mA", "300 mA"];

export const CABLE_SUGGESTIONS = [
  "NYM-J 3x1,5 mm²",
  "NYM-J 3x2,5 mm²",
  "NYM-J 5x1,5 mm²",
  "NYM-J 5x2,5 mm²",
  "NYM-J 5x6 mm²",
  "NYY-J 5x10 mm²",
  "NYY-J 5x16 mm²",
];

let idCounter = 0;

/**
 * Client-side device id.
 *
 * `crypto.randomUUID` is not available on every tablet in the field (it needs
 * a secure context, and the app is reachable over plain HTTP on the local
 * network), so this falls back to a counter + timestamp rather than throwing
 * halfway through adding a breaker.
 */
export function newId(prefix: string): string {
  idCounter += 1;
  const random =
    typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function"
      ? crypto.getRandomValues(new Uint32Array(1))[0].toString(36)
      : Math.floor(Math.random() * 0xffffffff).toString(36);
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}-${random}`;
}

/** A new device of the given kind, pre-filled from the catalogue defaults. */
export function makeDevice(kind: DeviceKind, overrides: Partial<PanelDevice> = {}): PanelDevice {
  const entry = catalogEntry(kind);
  return {
    id: newId("dev"),
    kind,
    te: entry.te,
    poles: entry.poles,
    designation: "",
    circuit: "",
    label: "",
    room: "",
    rating: "",
    residual_current: kind === "rcd" ? "30 mA" : "",
    rcd_type: kind === "rcd" || kind === "rcbo" ? "A" : "",
    cable: "",
    phase: "-",
    parent_id: null,
    note: "",
    ...overrides,
  };
}

export function emptyDocument(): PanelDocument {
  return {
    version: 1,
    supply: {
      system: "TN-S",
      voltage: "400/230 V",
      incoming: "",
      fuse: "",
      meter_number: "",
      note: "",
    },
    rows: [{ id: newId("row"), label: "Reihe 1", slots: 12, devices: [] }],
  };
}

export function rowUsedSlots(row: { devices: PanelDevice[] }): number {
  return row.devices.reduce((total, device) => total + Math.max(1, device.te || 1), 0);
}

/**
 * Next free Stromkreis number across the whole board.
 *
 * Numeric circuit labels only; a board using "K1"/"K2" keeps its scheme and
 * simply gets no suggestion rather than a nonsensical "1" alongside "K7".
 */
export function nextCircuitNumber(document: PanelDocument): string {
  let highest = 0;
  for (const row of document.rows) {
    for (const device of row.devices) {
      const parsed = Number.parseInt(device.circuit, 10);
      if (Number.isFinite(parsed) && String(parsed) === device.circuit.trim()) {
        highest = Math.max(highest, parsed);
      }
    }
  }
  return String(highest + 1);
}
