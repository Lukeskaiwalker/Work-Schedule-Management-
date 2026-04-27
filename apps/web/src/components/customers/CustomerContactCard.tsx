import type { Customer } from "../../types";

type Props = {
  customer: Customer;
  language: "de" | "en";
};

/**
 * "Kontaktdaten" card used on the customer detail page. Pure presentational —
 * renders every field with a label, gracefully falling back to an em-dash
 * when a field is null.
 */
export function CustomerContactCard({ customer, language }: Props) {
  const de = language === "de";
  // Birthday comes from the API as ISO YYYY-MM-DD; format it for display
  // using the user's preferred locale. Falls back to the raw string if
  // parsing fails (defensive — the input came from a `<input type="date">`).
  const birthdayDisplay = (() => {
    if (!customer.birthday) return null;
    const parsed = new Date(`${customer.birthday}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return customer.birthday;
    return parsed.toLocaleDateString(de ? "de-DE" : "en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  })();

  const rows: Array<{ label: string; value: string | null; href?: string | null }> = [
    {
      label: de ? "Adresse" : "Address",
      value: customer.address,
    },
    {
      label: de ? "Ansprechpartner" : "Contact person",
      value: customer.contact_person,
    },
    {
      label: de ? "E-Mail" : "Email",
      value: customer.email,
      href: customer.email ? `mailto:${customer.email}` : null,
    },
    {
      label: de ? "Telefon" : "Phone",
      value: customer.phone,
      href: customer.phone ? `tel:${customer.phone.replace(/\s+/g, "")}` : null,
    },
    {
      label: de ? "Geburtstag" : "Birthday",
      value: birthdayDisplay,
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
