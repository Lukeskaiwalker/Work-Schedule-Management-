/**
 * AdminIdsConnectCard — wholesaler webshop (IDS-Connect) setup.
 *
 * IDS-Connect is the German wholesale trade's punchout standard: our software
 * hands the browser to the wholesaler's own webshop carrying credentials and a
 * return address, the user shops there, and the finished cart comes back to us
 * as XML and becomes a draft order.
 *
 * Every wholesaler publishes their own *IDS-Datenblatt* fixing the entry URL
 * and the exact form-field names, and they differ. So the field names are
 * editable data here rather than code — configuring a second wholesaler is a
 * form somebody fills in, not a deploy.
 *
 * Two things this card is careful about:
 *
 *   The password is write-only. It is stored encrypted, never sent back to the
 *   browser, and leaving the field untouched keeps whatever is stored — so
 *   changing the port cannot silently wipe the ordering credential.
 *
 *   "Prüfen" contacts nobody. A punchout has no server-to-server endpoint and
 *   "do these credentials work" is only answerable by a human logging in. What
 *   it does check is everything that goes wrong before that — above all a
 *   return address pointing at localhost, which resolves to the fitter's own
 *   laptop and loses their whole basket at the last step.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { useAppContext } from "../../context/AppContext";
import type { WerkstattSupplier } from "../../types/werkstatt";
import type { IdsConnection, IdsConnectionTest } from "../../types/werkstattProcurement";
import { listSuppliers } from "../../utils/werkstattSuppliersApi";
import {
  deleteIdsConnection,
  listIdsConnections,
  saveIdsConnection,
  testIdsConnection,
} from "../../utils/werkstattOrdersApi";

/** Placeholder shown in the password box when one is already stored. */
const PASSWORD_MASK = "••••••••";

interface FormState {
  supplierId: number | null;
  isEnabled: boolean;
  entryUrl: string;
  username: string;
  password: string;
  customerNumber: string;
  charset: string;
  hookBaseUrl: string;
  fieldMapJson: string;
}

const EMPTY_FORM: FormState = {
  supplierId: null,
  isEnabled: false,
  entryUrl: "",
  username: "",
  password: "",
  customerNumber: "",
  charset: "ISO-8859-1",
  hookBaseUrl: "",
  fieldMapJson: "",
};

export function AdminIdsConnectCard() {
  const { token, language } = useAppContext();
  const de = language === "de";

  const [suppliers, setSuppliers] = useState<WerkstattSupplier[]>([]);
  const [connections, setConnections] = useState<IdsConnection[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<IdsConnectionTest | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const current = connections.find((c) => c.supplier_id === form.supplierId) ?? null;

  const load = useCallback(async () => {
    try {
      const [supplierRows, connectionRows] = await Promise.all([
        listSuppliers(token),
        listIdsConnections(token),
      ]);
      setSuppliers(supplierRows.filter((supplier) => !supplier.is_archived));
      setConnections(connectionRows);
      return connectionRows;
    } catch (err) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Load the chosen supplier's stored configuration into the form. */
  function selectSupplier(supplierId: number | null) {
    const existing = connections.find((c) => c.supplier_id === supplierId) ?? null;
    setCheck(null);
    setFeedback(null);
    setForm({
      supplierId,
      isEnabled: existing?.is_enabled ?? false,
      entryUrl: existing?.entry_url ?? "",
      username: existing?.username ?? "",
      // Never the real password — it is not sent to the browser at all.
      password: existing?.has_password ? PASSWORD_MASK : "",
      customerNumber: existing?.customer_number ?? "",
      charset: existing?.charset ?? "ISO-8859-1",
      hookBaseUrl: existing?.hook_base_url ?? "",
      fieldMapJson: existing ? JSON.stringify(existing.fetch_field_map, null, 2) : "",
    });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (form.supplierId === null) return;
    setSaving(true);
    setFeedback(null);

    let fetchFieldMap: Record<string, string> | undefined;
    if (form.fieldMapJson.trim()) {
      try {
        const parsed = JSON.parse(form.fieldMapJson) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("not an object");
        }
        fetchFieldMap = parsed as Record<string, string>;
      } catch {
        setSaving(false);
        setFeedback({
          ok: false,
          text: de
            ? "Das Feld-Mapping ist kein gültiges JSON-Objekt."
            : "The field map is not a valid JSON object.",
        });
        return;
      }
    }

    try {
      await saveIdsConnection(token, {
        supplier_id: form.supplierId,
        is_enabled: form.isEnabled,
        entry_url: form.entryUrl.trim(),
        http_method: "POST",
        ids_version: current?.ids_version ?? "2.5",
        charset: form.charset.trim() || "ISO-8859-1",
        username: form.username.trim() || null,
        // Omitting the key entirely is what tells the server "leave it alone".
        // Sending the mask back would store the bullet characters as the
        // password and break ordering on the next trip.
        ...(form.password === PASSWORD_MASK ? {} : { password: form.password }),
        customer_number: form.customerNumber.trim() || null,
        ...(fetchFieldMap ? { fetch_field_map: fetchFieldMap } : {}),
        hook_base_url: form.hookBaseUrl.trim() || null,
        notes: null,
      });
      const rows = await load();
      const saved = rows.find((c) => c.supplier_id === form.supplierId);
      if (saved) setForm((prev) => ({ ...prev, password: saved.has_password ? PASSWORD_MASK : "" }));
      setFeedback({ ok: true, text: de ? "Gespeichert." : "Saved." });
    } catch (err) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  }

  async function runCheck() {
    if (form.supplierId === null) return;
    setChecking(true);
    setFeedback(null);
    try {
      setCheck(await testIdsConnection(token, form.supplierId));
    } catch (err) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setChecking(false);
    }
  }

  async function remove() {
    if (form.supplierId === null || !current) return;
    setSaving(true);
    try {
      await deleteIdsConnection(token, form.supplierId);
      await load();
      selectSupplier(form.supplierId);
      setFeedback({ ok: true, text: de ? "Anbindung entfernt." : "Connection removed." });
    } catch (err) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="admin-page-card admin-settings-block">
      <h2 className="admin-page-card-title">
        {de ? "Großhandel-Shop (IDS-Connect)" : "Wholesaler shop (IDS-Connect)"}
      </h2>
      <p className="admin-tools-desc">
        {de
          ? "Anbindung an den Webshop eines Lieferanten (z. B. Unielektro). Die Werte stehen im IDS-Datenblatt des Großhändlers. Ist die Anbindung aktiv, können Mitarbeitende dort einkaufen und den Warenkorb direkt als Bestellung übernehmen."
          : "Punchout connection to a supplier's webshop. The values come from the wholesaler's IDS datasheet. Once enabled, staff can shop there and pull the cart straight back as an order."}
      </p>

      <form className="admin-settings-form" onSubmit={(e) => void save(e)}>
        <label className="admin-invite-field">
          <span className="admin-invite-field-label">{de ? "Lieferant" : "Supplier"}</span>
          <select
            className="admin-invite-input"
            value={form.supplierId ?? ""}
            onChange={(e) => selectSupplier(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">{de ? "— auswählen —" : "— choose —"}</option>
            {suppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name}
                {connections.some((c) => c.supplier_id === supplier.id) ? " ✓" : ""}
              </option>
            ))}
          </select>
        </label>

        {form.supplierId !== null && (
          <>
            <label className="admin-invite-field">
              <span className="admin-invite-field-label">
                {de ? "Shop-Adresse (Entry-URL)" : "Shop entry URL"}
              </span>
              <input
                type="url"
                className="admin-invite-input"
                value={form.entryUrl}
                onChange={(e) => setForm((p) => ({ ...p, entryUrl: e.target.value }))}
                placeholder="https://shop.unielektro.de/ids"
                autoComplete="off"
              />
            </label>

            <label className="admin-invite-field">
              <span className="admin-invite-field-label">
                {de ? "Benutzername" : "Username"}
              </span>
              <input
                type="text"
                className="admin-invite-input"
                value={form.username}
                onChange={(e) => setForm((p) => ({ ...p, username: e.target.value }))}
                autoComplete="off"
              />
            </label>

            <label className="admin-invite-field">
              <span className="admin-invite-field-label">{de ? "Passwort" : "Password"}</span>
              <input
                type="password"
                className="admin-invite-input"
                value={form.password}
                onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))}
                onFocus={(e) => {
                  // Clear the mask on focus so typing replaces rather than
                  // appends to it; leaving without typing restores it below.
                  if (e.target.value === PASSWORD_MASK) setForm((p) => ({ ...p, password: "" }));
                }}
                onBlur={(e) => {
                  if (!e.target.value && current?.has_password) {
                    setForm((p) => ({ ...p, password: PASSWORD_MASK }));
                  }
                }}
                autoComplete="new-password"
              />
            </label>

            <label className="admin-invite-field">
              <span className="admin-invite-field-label">
                {de ? "Kundennummer" : "Customer number"}
              </span>
              <input
                type="text"
                className="admin-invite-input"
                value={form.customerNumber}
                onChange={(e) => setForm((p) => ({ ...p, customerNumber: e.target.value }))}
                autoComplete="off"
              />
            </label>

            <label className="admin-invite-field">
              <span className="admin-invite-field-label">
                {de ? "Rückgabe-Adresse (optional)" : "Return address (optional)"}
              </span>
              <input
                type="url"
                className="admin-invite-input"
                value={form.hookBaseUrl}
                onChange={(e) => setForm((p) => ({ ...p, hookBaseUrl: e.target.value }))}
                placeholder={current?.hook_url_preview ?? "https://smpl.example.de"}
                autoComplete="off"
              />
              <small className="admin-tools-desc">
                {de
                  ? "Nur nötig, wenn der Server aus dem Browser der Mitarbeitenden unter einer anderen Adresse erreichbar ist als er sich selbst kennt."
                  : "Only needed when staff browsers reach this server under a different address than it knows itself by."}
              </small>
            </label>

            <label className="admin-invite-field">
              <span className="admin-invite-field-label">
                {de ? "Zeichensatz" : "Charset"}
              </span>
              <input
                type="text"
                className="admin-invite-input"
                value={form.charset}
                onChange={(e) => setForm((p) => ({ ...p, charset: e.target.value }))}
                placeholder="ISO-8859-1"
                autoComplete="off"
              />
              <small className="admin-tools-desc">
                {de
                  ? "Meist ISO-8859-1. Falscher Zeichensatz macht aus „Möller“ ein „MÃ¶ller“."
                  : "Usually ISO-8859-1. The wrong one turns “Möller” into “MÃ¶ller”."}
              </small>
            </label>

            <label className="admin-invite-field">
              <span className="admin-invite-field-label">
                {de ? "Feld-Mapping (JSON)" : "Field map (JSON)"}
              </span>
              <textarea
                className="admin-invite-input"
                rows={7}
                spellCheck={false}
                value={form.fieldMapJson}
                onChange={(e) => setForm((p) => ({ ...p, fieldMapJson: e.target.value }))}
                placeholder={'{\n  "ACTION": "WWWSHOP",\n  "USERNAME": "{username}",\n  "HOOK_URL": "{hook_url}"\n}'}
              />
              <small className="admin-tools-desc">
                {de
                  ? "Die Formularfelder, die der Shop erwartet. Platzhalter: {username}, {password}, {customer_number}, {hook_url}, {ids_version}."
                  : "The form fields the shop expects. Placeholders: {username}, {password}, {customer_number}, {hook_url}, {ids_version}."}
              </small>
            </label>

            {/* No `admin-invite-field` here: it stacks its children in a
                column, which would put the tick above its own label. */}
            <label className="admin-settings-checkbox">
              <input
                type="checkbox"
                checked={form.isEnabled}
                onChange={(e) => setForm((p) => ({ ...p, isEnabled: e.target.checked }))}
              />
              <span>
                {de
                  ? "Anbindung aktiv (im Werkstatt-Bereich nutzbar)"
                  : "Connection enabled (usable from the workshop area)"}
              </span>
            </label>

            {check && (
              <div className="admin-settings-status">
                <span
                  className={`admin-settings-status-dot${check.ok ? " admin-settings-status-dot--ok" : ""}`}
                />
                {check.ok
                  ? de
                    ? "Konfiguration sieht vollständig aus."
                    : "Configuration looks complete."
                  : check.problems.join(" · ")}
              </div>
            )}
            {check && (
              <pre className="admin-settings-preview">
                {`${de ? "Rückgabe-Adresse" : "Return address"}: ${check.hook_url}\n\n${Object.entries(
                  check.preview_fields,
                )
                  .map(([name, value]) => `${name} = ${value}`)
                  .join("\n")}`}
              </pre>
            )}
            {feedback && (
              <div className="admin-settings-status">
                <span
                  className={`admin-settings-status-dot${feedback.ok ? " admin-settings-status-dot--ok" : ""}`}
                />
                {feedback.text}
              </div>
            )}

            <div className="admin-settings-form-actions">
              <button type="submit" className="admin-invite-submit" disabled={saving}>
                {saving ? (de ? "Speichern…" : "Saving…") : de ? "Speichern" : "Save"}
              </button>
              <button
                type="button"
                className="admin-invite-submit admin-invite-submit--secondary"
                onClick={() => void runCheck()}
                disabled={checking || !current}
              >
                {checking ? (de ? "Prüfe…" : "Checking…") : de ? "Prüfen" : "Check"}
              </button>
              {current && (
                <button
                  type="button"
                  className="admin-invite-submit admin-invite-submit--secondary"
                  onClick={() => void remove()}
                  disabled={saving}
                >
                  {de ? "Anbindung entfernen" : "Remove connection"}
                </button>
              )}
            </div>
          </>
        )}
      </form>
    </div>
  );
}
