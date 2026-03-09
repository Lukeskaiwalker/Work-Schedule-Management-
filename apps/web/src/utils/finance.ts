import { EMPTY_PROJECT_FINANCE_FORM } from "../constants";
import type { Language, ProjectFinance, ProjectFinanceFormState } from "../types";

export function financeLabel(field: keyof ProjectFinanceFormState, language: Language) {
  const labels: Record<keyof ProjectFinanceFormState, { de: string; en: string }> = {
    order_value_net: { de: "Auftragswert netto", en: "Order value (net)" },
    down_payment_35: { de: "35% Anzahlung", en: "35% down payment" },
    main_components_50: { de: "50% Hauptkomponenten", en: "50% main components" },
    final_invoice_15: { de: "15% Schlussrechnung", en: "15% final invoice" },
    planned_costs: { de: "Geplante Kosten", en: "Planned costs" },
    actual_costs: { de: "Tatsächliche Kosten", en: "Actual costs" },
    contribution_margin: { de: "Deckungsbeitrag", en: "Contribution margin" },
  };
  return language === "de" ? labels[field].de : labels[field].en;
}

export function projectFinanceToFormState(finance: ProjectFinance | null): ProjectFinanceFormState {
  if (!finance) return { ...EMPTY_PROJECT_FINANCE_FORM };
  return {
    order_value_net: finance.order_value_net == null ? "" : String(finance.order_value_net),
    down_payment_35: finance.down_payment_35 == null ? "" : String(finance.down_payment_35),
    main_components_50: finance.main_components_50 == null ? "" : String(finance.main_components_50),
    final_invoice_15: finance.final_invoice_15 == null ? "" : String(finance.final_invoice_15),
    planned_costs: finance.planned_costs == null ? "" : String(finance.planned_costs),
    actual_costs: finance.actual_costs == null ? "" : String(finance.actual_costs),
    contribution_margin: finance.contribution_margin == null ? "" : String(finance.contribution_margin),
  };
}

export function formatMoney(value: number | null | undefined, language: Language) {
  if (value == null || Number.isNaN(value)) return "-";
  const locale = language === "de" ? "de-DE" : "en-US";
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 2,
  }).format(value);
}

export function parseNullableDecimalInput(value: string): number | null {
  const normalized = value.trim().replace(",", ".");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}
