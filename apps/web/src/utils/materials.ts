import type { Language, MaterialNeedStatus } from "../types";

export function normalizeMaterialNeedStatus(value?: string | null): MaterialNeedStatus {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
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
  return language === "de" ? "Bestellen" : "Order";
}

export function materialNeedStatusClass(status: MaterialNeedStatus) {
  if (status === "completed") return "completed";
  if (status === "on_the_way") return "on-the-way";
  if (status === "available") return "available";
  return "order";
}

export function nextMaterialNeedStatus(status: MaterialNeedStatus): MaterialNeedStatus {
  if (status === "order") return "on_the_way";
  if (status === "on_the_way") return "available";
  if (status === "available") return "order";
  return "order";
}

export function formatMaterialQuantity(value: number, language: Language) {
  if (!Number.isFinite(value)) return "";
  return new Intl.NumberFormat(language === "de" ? "de-DE" : "en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  }).format(value);
}
