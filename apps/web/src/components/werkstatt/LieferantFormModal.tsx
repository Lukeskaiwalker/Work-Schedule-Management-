/**
 * LieferantFormModal — the supplier create/edit form and its state helpers.
 *
 * Extracted from `WerkstattLieferantenPage` when the two ordering settings
 * were added. Besides contact and address fields the form owns:
 *
 *   Bestellweg (`order_channel`)              — which hand-over the order
 *                                               drawer offers for this supplier
 *   Übertragene Artikelnummer (`order_identifier`) — what the cart or export
 *                                               carries per line
 *
 * They live on the supplier rather than on the admin's IDS card because they
 * apply to suppliers without any shop connection too; the admin card only
 * shows the identifier read-only and points here.
 *
 * `formStateFromSupplier` / `payloadFromForm` are exported because the round
 * trip is the thing worth testing: a form that silently reset "both" to the
 * default would flip a supplier's cart shape on the next unrelated edit.
 */
import type { ChangeEvent, FormEvent } from "react";

import type {
  WerkstattOrderChannel,
  WerkstattOrderIdentifier,
  WerkstattSupplier,
  WerkstattSupplierCreate,
} from "../../types/werkstatt";

export type SupplierFormState = {
  name: string;
  short_name: string;
  email: string;
  order_email: string;
  phone: string;
  contact_person: string;
  address_street: string;
  address_zip: string;
  address_city: string;
  address_country: string;
  default_lead_time_days: string;  // free-text in the form, parsed on submit
  notes: string;
  order_identifier: WerkstattOrderIdentifier;
  order_channel: WerkstattOrderChannel;
};

export const EMPTY_SUPPLIER_FORM: SupplierFormState = {
  name: "",
  short_name: "",
  email: "",
  order_email: "",
  phone: "",
  contact_person: "",
  address_street: "",
  address_zip: "",
  address_city: "",
  address_country: "",
  default_lead_time_days: "",
  notes: "",
  order_identifier: "supplier_no",
  order_channel: "manual",
};

/** The identifier options, in the order the select shows them. */
export const ORDER_IDENTIFIER_OPTIONS: ReadonlyArray<{
  value: WerkstattOrderIdentifier;
  label_de: string;
  label_en: string;
}> = [
  {
    value: "supplier_no",
    label_de: "Nur Lieferanten-Artikelnummer (empfohlen)",
    label_en: "Supplier article number only (recommended)",
  },
  {
    value: "supplier_no_or_ean",
    label_de: "Lieferanten-Nr., sonst EAN",
    label_en: "Supplier no., otherwise EAN",
  },
  { value: "ean", label_de: "Nur EAN", label_en: "EAN only" },
  {
    value: "both",
    label_de: "Lieferanten-Nr. und EAN",
    label_en: "Supplier no. and EAN",
  },
];

export const ORDER_CHANNEL_OPTIONS: ReadonlyArray<{
  value: WerkstattOrderChannel;
  label_de: string;
  label_en: string;
}> = [
  { value: "ids", label_de: "Shop-Anbindung (IDS)", label_en: "Shop connection (IDS)" },
  { value: "manual", label_de: "Manuell (Export)", label_en: "Manual (export)" },
];

export function formStateFromSupplier(supplier: WerkstattSupplier): SupplierFormState {
  return {
    name: supplier.name,
    short_name: supplier.short_name ?? "",
    email: supplier.email ?? "",
    order_email: supplier.order_email ?? "",
    phone: supplier.phone ?? "",
    contact_person: supplier.contact_person ?? "",
    address_street: supplier.address_street ?? "",
    address_zip: supplier.address_zip ?? "",
    address_city: supplier.address_city ?? "",
    address_country: supplier.address_country ?? "",
    default_lead_time_days:
      supplier.default_lead_time_days != null
        ? String(supplier.default_lead_time_days)
        : "",
    notes: supplier.notes ?? "",
    order_identifier: supplier.order_identifier ?? "supplier_no",
    order_channel: supplier.order_channel ?? "manual",
  };
}

/** Convert form state to the API's create/update payload. Empty strings turn
 *  into `null` so the backend records "field cleared" rather than "field is
 *  the empty string" — Pydantic distinguishes the two. */
export function payloadFromForm(form: SupplierFormState): WerkstattSupplierCreate {
  const trimToNull = (value: string): string | null => {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  };
  const leadTime = form.default_lead_time_days.trim();
  const leadTimeParsed = leadTime === "" ? null : Number.parseInt(leadTime, 10);
  return {
    name: form.name.trim(),
    short_name: trimToNull(form.short_name),
    email: trimToNull(form.email),
    order_email: trimToNull(form.order_email),
    phone: trimToNull(form.phone),
    contact_person: trimToNull(form.contact_person),
    address_street: trimToNull(form.address_street),
    address_zip: trimToNull(form.address_zip),
    address_city: trimToNull(form.address_city),
    address_country: trimToNull(form.address_country),
    default_lead_time_days:
      leadTimeParsed != null && Number.isFinite(leadTimeParsed) && leadTimeParsed >= 0
        ? leadTimeParsed
        : null,
    notes: trimToNull(form.notes),
    order_identifier: form.order_identifier,
    order_channel: form.order_channel,
  };
}

export type SupplierFieldChange = (
  field: keyof SupplierFormState,
) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => void;

export interface LieferantFormModalProps {
  de: boolean;
  editing: WerkstattSupplier | null;
  form: SupplierFormState;
  onFieldChange: SupplierFieldChange;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  submitting: boolean;
}

export function LieferantFormModal({
  de,
  editing,
  form,
  onFieldChange,
  onCancel,
  onSubmit,
  submitting,
}: LieferantFormModalProps) {
  const title = editing
    ? de ? "Lieferant bearbeiten" : "Edit supplier"
    : de ? "Neuer Lieferant" : "New supplier";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 16,
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !submitting) onCancel();
      }}
    >
      <form
        onSubmit={onSubmit}
        style={{
          background: "var(--surface, #fff)",
          color: "var(--text, #111)",
          borderRadius: 10,
          padding: 24,
          maxWidth: 640,
          width: "100%",
          maxHeight: "90vh",
          overflowY: "auto",
          boxShadow: "0 24px 60px rgba(0,0,0,0.4)",
        }}
      >
        <h2 style={{ marginTop: 0 }}>{title}</h2>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <label style={{ gridColumn: "1 / -1" }}>
            <span>{de ? "Name *" : "Name *"}</span>
            <input
              type="text"
              required
              maxLength={200}
              value={form.name}
              onChange={onFieldChange("name")}
              style={{ width: "100%", padding: 8 }}
              autoFocus
            />
          </label>

          <label>
            <span>{de ? "Kürzel" : "Short name"}</span>
            <input
              type="text"
              maxLength={50}
              value={form.short_name}
              onChange={onFieldChange("short_name")}
              style={{ width: "100%", padding: 8 }}
            />
          </label>

          <label>
            <span>{de ? "Std. Lieferzeit (Werktage)" : "Default lead time (days)"}</span>
            <input
              type="number"
              min={0}
              step={1}
              value={form.default_lead_time_days}
              onChange={onFieldChange("default_lead_time_days")}
              style={{ width: "100%", padding: 8 }}
            />
          </label>

          <label>
            <span>{de ? "Kontaktperson" : "Contact person"}</span>
            <input
              type="text"
              value={form.contact_person}
              onChange={onFieldChange("contact_person")}
              style={{ width: "100%", padding: 8 }}
            />
          </label>

          <label>
            <span>{de ? "Telefon" : "Phone"}</span>
            <input
              type="tel"
              value={form.phone}
              onChange={onFieldChange("phone")}
              style={{ width: "100%", padding: 8 }}
            />
          </label>

          <label>
            <span>{de ? "E-Mail (allgemein)" : "Email (general)"}</span>
            <input
              type="email"
              value={form.email}
              onChange={onFieldChange("email")}
              style={{ width: "100%", padding: 8 }}
            />
          </label>

          <label>
            <span>{de ? "E-Mail (Bestellungen)" : "Email (orders)"}</span>
            <input
              type="email"
              value={form.order_email}
              onChange={onFieldChange("order_email")}
              style={{ width: "100%", padding: 8 }}
            />
          </label>

          <label style={{ gridColumn: "1 / -1" }}>
            <span>{de ? "Straße" : "Street"}</span>
            <input
              type="text"
              value={form.address_street}
              onChange={onFieldChange("address_street")}
              style={{ width: "100%", padding: 8 }}
            />
          </label>

          <label>
            <span>{de ? "PLZ" : "ZIP"}</span>
            <input
              type="text"
              maxLength={20}
              value={form.address_zip}
              onChange={onFieldChange("address_zip")}
              style={{ width: "100%", padding: 8 }}
            />
          </label>

          <label>
            <span>{de ? "Stadt" : "City"}</span>
            <input
              type="text"
              value={form.address_city}
              onChange={onFieldChange("address_city")}
              style={{ width: "100%", padding: 8 }}
            />
          </label>

          <label style={{ gridColumn: "1 / -1" }}>
            <span>{de ? "Land" : "Country"}</span>
            <input
              type="text"
              value={form.address_country}
              onChange={onFieldChange("address_country")}
              style={{ width: "100%", padding: 8 }}
            />
          </label>

          <label>
            <span>{de ? "Bestellweg" : "Order channel"}</span>
            <select
              value={form.order_channel}
              onChange={onFieldChange("order_channel")}
              style={{ width: "100%", padding: 8 }}
            >
              {ORDER_CHANNEL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {de ? option.label_de : option.label_en}
                </option>
              ))}
            </select>
            <small className="werkstatt-supplier-setting-help">
              {de
                ? "„Shop-Anbindung“ braucht eine aktive IDS-Verbindung (Admin). „Manuell“ bietet CSV-Download und Zwischenablage."
                : "“Shop connection” needs an enabled IDS connection (admin). “Manual” offers CSV download and clipboard."}
            </small>
          </label>

          <label>
            <span>{de ? "Übertragene Artikelnummer" : "Identifier sent"}</span>
            <select
              value={form.order_identifier}
              onChange={onFieldChange("order_identifier")}
              style={{ width: "100%", padding: 8 }}
            >
              {ORDER_IDENTIFIER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {de ? option.label_de : option.label_en}
                </option>
              ))}
            </select>
            <small className="werkstatt-supplier-setting-help">
              {de
                ? "Die meisten Webshops importieren nur ihre eigene Artikelnummer."
                : "Most webshops import only their own article number."}
            </small>
          </label>

          <label style={{ gridColumn: "1 / -1" }}>
            <span>{de ? "Notizen" : "Notes"}</span>
            <textarea
              value={form.notes}
              onChange={onFieldChange("notes")}
              rows={3}
              style={{ width: "100%", padding: 8, resize: "vertical" }}
            />
          </label>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button type="button" className="ghost" onClick={onCancel} disabled={submitting}>
            {de ? "Abbrechen" : "Cancel"}
          </button>
          <button type="submit" disabled={submitting || form.name.trim() === ""}>
            {submitting
              ? de ? "Speichere…" : "Saving…"
              : editing
                ? de ? "Speichern" : "Save"
                : de ? "Anlegen" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}
