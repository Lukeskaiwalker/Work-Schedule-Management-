/**
 * Firma or Privatkunde: the one place for the words, and the pill that
 * says them wherever a customer is named — the contact card's header, the
 * list row, the project's Kontakt card. A row from before the field has no
 * type; the pill stays away rather than guessing, and the label reads as
 * plain "Kunde".
 */
import type { Customer } from "../../types";
import "../../styles/customer-detail.css";

type CustomerType = Customer["customer_type"];
type Language = "de" | "en";

/** The noun for the type: what the label in front of the name should say. */
export function customerTypeLabel(type: CustomerType, language: Language): string {
  const de = language === "de";
  if (type === "company") return de ? "Firma" : "Company";
  if (type === "private") return de ? "Privatkunde" : "Private customer";
  return de ? "Kunde" : "Customer";
}

type Props = {
  type: CustomerType;
  language: Language;
  /** The list row has less room than a card header: "Privat" instead of "Privatkunde". */
  compact?: boolean;
};

export function CustomerTypeBadge({ type, language, compact = false }: Props) {
  if (type !== "company" && type !== "private") return null;
  const de = language === "de";
  const text = compact && type === "private" ? (de ? "Privat" : "Private") : customerTypeLabel(type, language);
  return (
    <span className={`customer-type-badge customer-type-badge--${type}`} title={customerTypeLabel(type, language)}>
      {text}
    </span>
  );
}
