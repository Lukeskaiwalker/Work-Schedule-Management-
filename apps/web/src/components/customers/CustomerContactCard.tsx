import type { Customer } from "../../types";
import { CustomerTypeBadge } from "./CustomerTypeBadge";
import "../../styles/customer-detail.css";

type Props = {
  customer: Customer;
  language: "de" | "en";
};

/** ISO YYYY-MM-DD as the office writes dates; the raw string if it does not parse. */
function formatIsoDate(iso: string | null | undefined, language: "de" | "en"): string | null {
  if (!iso) return null;
  const parsed = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString(language === "de" ? "de-DE" : "en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function telHref(number: string | null | undefined): string | null {
  return number ? `tel:${number.replace(/\s+/g, "")}` : null;
}

/**
 * "Kontaktdaten" card used on the customer detail page. Pure presentational —
 * renders every field with a label, gracefully falling back to an em-dash
 * when a field is null. The header says whether this is a Firma or a
 * Privatkunde; only a company has an Ansprechpartner row (a row from before
 * the field keeps it, since nobody has said yet what it is).
 */
export function CustomerContactCard({ customer, language }: Props) {
  const de = language === "de";
  const isPrivate = customer.customer_type === "private";

  const rows: Array<{ label: string; value: string | null; href?: string | null }> = [
    {
      label: de ? "Adresse" : "Address",
      value: customer.address,
    },
    ...(isPrivate
      ? []
      : [
          {
            label: de ? "Ansprechpartner" : "Contact person",
            value: customer.contact_person,
          },
        ]),
    {
      label: de ? "E-Mail" : "Email",
      value: customer.email,
      href: customer.email ? `mailto:${customer.email}` : null,
    },
    {
      label: de ? "Telefon" : "Phone",
      value: customer.phone,
      href: telHref(customer.phone),
    },
    {
      label: de ? "Mobil" : "Mobile",
      value: customer.mobile ?? null,
      href: telHref(customer.mobile),
    },
    {
      label: de ? "Geburtstag" : "Birthday",
      value: formatIsoDate(customer.birthday, language),
    },
    {
      label: de ? "Steuer-ID" : "Tax ID",
      value: customer.tax_id,
    },
    {
      // Marktakteur-Nummer from the German Marktstammdatenregister, e.g. for
      // private PV operators. Only meaningful for energy-customer rows;
      // falls back to em-dash when null (matches the other optional rows).
      label: de ? "Marktakteur-Nr." : "Market actor no.",
      value: customer.marktakteur_nummer,
    },
  ];

  return (
    <section className="customer-contact-card">
      <header className="customer-contact-card-head">
        <h3 className="customer-contact-card-title">
          {de ? "Kontaktdaten" : "Contact details"}
        </h3>
        <CustomerTypeBadge type={customer.customer_type} language={language} />
      </header>
      <dl className="customer-contact-card-list">
        {rows.map((row) => (
          <div key={`customer-field-${row.label}`} className="customer-contact-card-row">
            <dt className="customer-contact-card-label">{row.label}</dt>
            <dd className="customer-contact-card-value">
              {row.value ? (
                row.href ? (
                  <a href={row.href}>{row.value}</a>
                ) : (
                  row.value
                )
              ) : (
                <span className="muted">—</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
