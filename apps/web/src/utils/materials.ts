import type { Language, MaterialNeedStatus } from "../types";
import type { MaterialNeedSkipReason } from "../types/materialNeeds";

/**
 * The ladder, in order. "ordered" (v2.15) sits between "we should buy this"
 * and "it is on a van": it is set automatically when a need lands on a
 * Werkstatt order and cleared when that order is cancelled.
 */
export const MATERIAL_NEED_STATUSES: readonly MaterialNeedStatus[] = [
  "order",
  "ordered",
  "on_the_way",
  "available",
  "completed",
];

export function normalizeMaterialNeedStatus(value?: string | null): MaterialNeedStatus {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "ordered" || normalized === "bestellt") {
    return "ordered";
  }
  if (
    normalized === "on_the_way" ||
    normalized === "on-the-way" ||
    normalized === "on the way" ||
    normalized === "on its way" ||
    normalized === "unterwegs"
  ) {
    return "on_the_way";
  }
  if (normalized === "available" || normalized === "verfuegbar" || normalized === "verfügbar") {
    return "available";
  }
  if (
    normalized === "completed" ||
    normalized === "complete" ||
    normalized === "done" ||
    normalized === "erledigt" ||
    normalized === "abgeschlossen"
  ) {
    return "completed";
  }
  return "order";
}

export function materialNeedStatusLabel(status: MaterialNeedStatus, language: Language) {
  if (status === "completed") return language === "de" ? "Erledigt" : "Completed";
  if (status === "on_the_way") return language === "de" ? "Unterwegs" : "On its way";
  if (status === "available") return language === "de" ? "Verfügbar" : "Available";
  if (status === "ordered") return language === "de" ? "Bestellt" : "Ordered";
  return language === "de" ? "Bestellen" : "Order";
}

export function materialNeedStatusClass(status: MaterialNeedStatus) {
  if (status === "completed") return "completed";
  if (status === "on_the_way") return "on-the-way";
  if (status === "available") return "available";
  if (status === "ordered") return "ordered";
  return "order";
}

export function nextMaterialNeedStatus(status: MaterialNeedStatus): MaterialNeedStatus {
  if (status === "order") return "ordered";
  if (status === "ordered") return "on_the_way";
  if (status === "on_the_way") return "available";
  if (status === "available") return "order";
  return "order";
}

/**
 * Why a selected need was left out of "Bestellung erstellen".
 *
 * Shown per row in the confirmation modal: a count of skipped rows is an
 * invitation to compare two screens by hand, which is the work this screen
 * exists to remove.
 */
export function needSkipReasonLabel(
  reason: MaterialNeedSkipReason,
  language: Language,
  orderNumber?: string | null,
) {
  const de = language === "de";
  if (reason === "already_ordered") {
    if (orderNumber) return de ? `Bereits in ${orderNumber}` : `Already in ${orderNumber}`;
    return de ? "Bereits in Bestellung" : "Already in an order";
  }
  // Covers "Erledigt" AND "Verfügbar": both mean the material is no longer
  // missing, and ordering it again is the mistake this skip prevents.
  if (reason === "completed") {
    return de ? "Nicht mehr offen" : "No longer open";
  }
  if (reason === "other_supplier") return de ? "Anderer Lieferant" : "Different supplier";
  if (reason === "no_supplier") {
    return de ? "Katalog-Artikel ohne Lieferant" : "Catalogue item without a supplier";
  }
  return de ? "Kein Katalog-Artikel" : "No catalogue item";
}

/**
 * "3 bereits in einer Bestellung, 1 ohne Katalog-Artikel" — why a selection
 * cannot be ordered, in the words of the rows themselves.
 *
 * A single "n ohne Katalog-Artikel" blamed the one reason the recovery action
 * exists for, even when every skipped row was skipped for a different one,
 * and pointed the user at an action that would not have helped.
 *
 * The phrases are written out rather than derived from `needSkipReasonLabel`:
 * that one names a single row ("Kein Katalog-Artikel"), and a German noun
 * does not survive being lower-cased into the middle of a count.
 */
const SKIP_PHRASES: Readonly<Record<MaterialNeedSkipReason, { de: string; en: string }>> = {
  already_ordered: { de: "bereits in einer Bestellung", en: "already in an order" },
  no_catalog_item: { de: "ohne Katalog-Artikel", en: "without a catalogue article" },
  no_supplier: { de: "ohne Lieferant", en: "without a supplier" },
  other_supplier: { de: "von einem anderen Lieferanten", en: "from another supplier" },
  completed: { de: "nicht mehr offen", en: "no longer open" },
};

/** The order they are listed in: the most actionable reason first. */
const SKIP_ORDER: readonly MaterialNeedSkipReason[] = [
  "already_ordered",
  "no_catalog_item",
  "no_supplier",
  "other_supplier",
  "completed",
];

export function needSkipSummary(
  reasons: readonly MaterialNeedSkipReason[],
  language: Language,
): string {
  const tally = new Map<MaterialNeedSkipReason, number>();
  for (const reason of reasons) tally.set(reason, (tally.get(reason) ?? 0) + 1);
  return SKIP_ORDER.filter((reason) => tally.has(reason))
    .map((reason) => `${tally.get(reason)} ${SKIP_PHRASES[reason][language === "de" ? "de" : "en"]}`)
    .join(", ");
}

export function formatMaterialQuantity(value: number, language: Language) {
  if (!Number.isFinite(value)) return "";
  return new Intl.NumberFormat(language === "de" ? "de-DE" : "en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  }).format(value);
}

export interface OrderQuantityPreview {
  /** Whole units, as they would land on the wholesaler's basket. */
  quantity: number;
  /** German/English sentence when the value had to be changed. */
  warning: string | null;
}

/**
 * Parse a free-text quantity the way a German keyboard writes numbers.
 *
 * Twin of `parse_quantity_text` in
 * `apps/api/app/services/material_need_rows.py`; a value that reads as 2.5
 * here and 25 there is how a basket goes wrong, so both are unit-tested
 * against the same cases.
 */
function parseQuantityText(raw: string): number | null {
  const compact = raw.replace(/\s/g, "");
  if (!compact) return null;
  let normalized = compact;
  if (compact.includes(",") && compact.includes(".")) {
    normalized =
      compact.lastIndexOf(",") > compact.lastIndexOf(".")
        ? compact.replace(/\./g, "").replace(",", ".")
        : compact.replace(/,/g, "");
  } else if (compact.includes(",")) {
    normalized = compact.replace(",", ".");
  }
  if (!/^[+-]?\d+(\.\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/**
 * What "Bestellung erstellen" would put on the line, and what to warn about.
 *
 * Rounding up is the safe direction — too much cable costs money, too little
 * costs a second trip — but never silently: the preview says so per position
 * and the same sentence is written onto the order line by the server.
 */
export function previewOrderQuantity(
  raw: string | null | undefined,
  language: Language,
): OrderQuantityPreview {
  const de = language === "de";
  const text = String(raw ?? "").trim();
  const parsed = parseQuantityText(text);
  if (parsed === null) {
    if (!text) {
      return {
        quantity: 1,
        warning: de
          ? "Keine Menge angegeben – 1 angenommen, bitte prüfen"
          : "No quantity given – assuming 1, please check",
      };
    }
    return {
      quantity: 1,
      warning: de
        ? `Menge '${text}' nicht lesbar – 1 angenommen, bitte prüfen`
        : `Quantity '${text}' is unreadable – assuming 1, please check`,
    };
  }
  if (parsed <= 0) {
    return {
      quantity: 1,
      warning: de
        ? `Menge '${text}' ist nicht bestellbar – 1 angenommen, bitte prüfen`
        : `Quantity '${text}' cannot be ordered – assuming 1, please check`,
    };
  }
  const rounded = Math.ceil(parsed);
  if (rounded !== parsed) {
    return {
      quantity: rounded,
      warning: de
        ? `Menge '${text}' auf ${rounded} aufgerundet – bitte prüfen`
        : `Quantity '${text}' rounded up to ${rounded} – please check`,
    };
  }
  return { quantity: rounded, warning: null };
}
