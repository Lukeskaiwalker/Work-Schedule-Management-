/**
 * What a Zugangsdaten row belongs to (components/customers/
 * CustomerCredentialsCard): the chip on the row and the select in the
 * form share this list and these words, so the two can never drift.
 */
import type { CustomerCredentialCategory } from "../../types";

/** In select order: the plant's devices first, then the portals, then the rest. */
export const CUSTOMER_CREDENTIAL_CATEGORIES: readonly CustomerCredentialCategory[] = [
  "inverter",
  "wallbox",
  "storage",
  "heatpump",
  "router",
  "portal",
  "other",
];

export const DEFAULT_CUSTOMER_CREDENTIAL_CATEGORY: CustomerCredentialCategory = "other";

export function isCustomerCredentialCategory(value: unknown): value is CustomerCredentialCategory {
  return typeof value === "string" && (CUSTOMER_CREDENTIAL_CATEGORIES as readonly string[]).includes(value);
}

export function credentialCategoryLabel(
  category: CustomerCredentialCategory,
  language: "de" | "en",
): string {
  const de = language === "de";
  switch (category) {
    case "inverter":
      return de ? "Wechselrichter" : "Inverter";
    case "wallbox":
      return "Wallbox";
    case "storage":
      return de ? "Speicher" : "Storage";
    case "heatpump":
      return de ? "Wärmepumpe" : "Heat pump";
    case "router":
      return "Router";
    case "portal":
      return "Portal";
    case "other":
      return de ? "Sonstiges" : "Other";
  }
}
