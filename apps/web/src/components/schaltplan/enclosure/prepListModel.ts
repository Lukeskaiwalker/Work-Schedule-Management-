/**
 * The pure half of "Automatisch ergänzt" and of the Daten tab's infeed hint
 * (docs/PANEL_ENCLOSURE_R4.md §8.4, §8.5): which override an item answers
 * to and what its select offers, how an item's line reads, and what the
 * infeed parser recognised in "Zuleitung" and led to.
 */
import { parseFuseAmps } from "../../../utils/cableSectionParse";
import { formatMmText } from "../../../utils/enclosureGeometry";
import { K96ESA5_MAX_FUSE_A } from "../../../utils/enclosurePrep";
import type { CabinetPrep, PrepItem } from "../../../types/panelEnclosure";

/** The groups with an override select (§2.2); `network_m` rides with `network`. */
export type OverrideKey = "supply" | "infeed" | "joints" | "network";

export interface OverrideOption {
  value: string;
  label: string;
}

const AUTO: OverrideOption = { value: "auto", label: "Automatisch" };
const OFF: OverrideOption = { value: "off", label: "Nicht ergänzen" };

export const OVERRIDE_OPTIONS: Readonly<Record<OverrideKey, readonly OverrideOption[]>> = {
  supply: [AUTO, { value: "SA", label: "SABO" }, { value: "LS", label: "LS 6 A" }, { value: "SI", label: "Sicherungsbox" }, OFF],
  infeed: [AUTO, { value: "K96ESA5", label: "K96ESA5" }, { value: "clamps", label: "Sammelschienenklemmen" }, OFF],
  joints: [AUTO, OFF],
  network: [AUTO, OFF],
};

/** The select's accessible name. */
export const OVERRIDE_LABELS: Readonly<Record<OverrideKey, string>> = {
  supply: "Spannungsversorgung",
  infeed: "Einspeisung",
  joints: "Sammelschienenverbinder",
  network: "Netzwerkleitung",
};

export const UNVERIFIED_PREP_TITLE = "Aus der Zeichnung abgeleitet — vor dem Einbau prüfen";
export const MANUAL_OFF_TEXT = "manuell abgewählt";

const JOINT_KEY = "accessory:ZZ55SAVE";

/** The override an item answers to; null for items without one (PEN split, the §14a block). */
export function overrideKeyOf(item: PrepItem): OverrideKey | null {
  if (item.override === null) return null;
  if (item.group === "supply") return "supply";
  if (item.group === "network") return "network";
  if (item.group === "busbar") return item.key === JOINT_KEY ? "joints" : "infeed";
  return null;
}

/** Switched off on this board — not merely left out by the rules (an existing tap keeps `auto`). */
export function isManualOff(item: PrepItem): boolean {
  return item.suppressed && item.override === "off";
}

/** "{qty} ×" + bold article + label, or "{qty} m" + label for wire sold by the metre. */
export function prepItemLine(item: PrepItem): { qty: string; articleNo: string | null; label: string } {
  if (item.unit === "m") return { qty: `${item.qty} m`, articleNo: null, label: item.label };
  return { qty: `${item.qty} ×`, articleNo: item.articleNo, label: item.label };
}

// ── Daten tab (§8.5) ─────────────────────────────────────────────────────────

const ADAPTER = "K96ESA5";

/** The infeed's own item (adapter or clamps): busbar group, an override, not the joint. */
function infeedItem(prep: CabinetPrep): PrepItem | undefined {
  return prep.items.find((item) => overrideKeyOf(item) === "infeed");
}

function outcome(prep: CabinetPrep, article: string | null): string {
  const item = infeedItem(prep);
  if (item && item.suppressed) return "nicht ergänzt (manuell abgewählt)";
  if (article === ADAPTER) return "Einspeiseadapter K96ESA5";
  if (article && item) return `${item.qty} × Sammelschienenklemme ${article}`;
  return "keine Sammelschienenklemme bis 185 mm² — Einspeisung gesondert planen";
}

/**
 * "Querschnitt erkannt: 16 mm² → Einspeiseadapter K96ESA5" and its variants;
 * " · Vorsicherung über 100 A prüfen" while the adapter is planned behind a
 * larger fuse. Null without a prep or without a `main` busbar zone.
 */
export function infeedHint(prep: CabinetPrep | null, fuse: unknown): string | null {
  const infeed = prep?.infeed;
  if (!prep || !infeed) return null;
  let text: string;
  if (infeed.mm2 === null && infeed.assumed) {
    text = "Kein Querschnitt erkannt → Einspeiseadapter K96ESA5 angenommen";
  } else {
    const head = infeed.mm2 === null
      ? `Kein Querschnitt erkannt${infeed.aluminium ? " (Al)" : ""}`
      : `Querschnitt erkannt: ${formatMmText(infeed.mm2)} mm²${infeed.aluminium ? " Al" : ""}`;
    text = `${head} → ${outcome(prep, infeed.article)}`;
  }
  const adapterPlanned = infeed.article === ADAPTER && !infeedItem(prep)?.suppressed;
  const amps = parseFuseAmps(fuse);
  return adapterPlanned && amps !== null && amps > K96ESA5_MAX_FUSE_A ? `${text} · Vorsicherung über 100 A prüfen` : text;
}
