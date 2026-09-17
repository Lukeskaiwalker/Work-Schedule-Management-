import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";

import { useAppContext } from "../../context/AppContext";
import {
  archiveSupplier,
  createSupplier,
  listSuppliers,
  updateSupplier,
} from "../../utils/werkstattSuppliersApi";
import type { WerkstattSupplier } from "../../types/werkstatt";
import {
  EMPTY_SUPPLIER_FORM,
  LieferantFormModal,
  formStateFromSupplier,
  payloadFromForm,
  type SupplierFormState,
} from "../../components/werkstatt/LieferantFormModal";
// The ordering-settings help text shares the orders sheet; Vite loads a
// stylesheet once however many modules import it.
import "../../styles/orders.css";


/**
 * WerkstattLieferantenPage — list/create/edit/archive UI on top of
 * `/api/werkstatt/suppliers`. Mutations are gated client-side on the
 * `werkstatt:manage` permission; the backend re-checks the same gate, so the
 * client check is purely UX (hide buttons that would 403).
 *
 * Columns: Name · Kontakt · Std. Lieferzeit · # Artikel · Letzte Bestellung.
 *
 * The form itself, its state helpers and the two ordering settings
 * (`order_channel`, `order_identifier`) live in
 * `components/werkstatt/LieferantFormModal.tsx`.
 */


function formatLastOrderAt(iso: string | null, de: boolean): string {
  if (!iso) return de ? "—" : "—";
  try {
    return new Date(iso).toLocaleDateString(de ? "de-DE" : "en-US");
  } catch {
    return iso;
  }
}


export function WerkstattLieferantenPage() {
  const { mainView, language, werkstattTab, token, user, setNotice, setError } =
    useAppContext();

  const canManage =
    user?.effective_permissions?.includes("werkstatt:manage") ?? false;
  const de = language === "de";

  // ── Data state ─────────────────────────────────────────────────────────
  const [suppliers, setSuppliers] = useState<WerkstattSupplier[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);

  // ── Modal state ────────────────────────────────────────────────────────
  // `editing` distinguishes "create" (null) from "edit" (the row being edited).
  // `form` always holds the in-flight values; submit reads from here.
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<WerkstattSupplier | null>(null);
  const [form, setForm] = useState<SupplierFormState>(EMPTY_SUPPLIER_FORM);
  const [submitting, setSubmitting] = useState(false);

  // ── Per-row action menu (the … overflow button) ────────────────────────
  // We keep a single open id rather than per-row state so opening one menu
  // closes any other.
  const [menuOpenId, setMenuOpenId] = useState<number | null>(null);

  const isActiveTab = mainView === "werkstatt" && werkstattTab === "lieferanten";

  // Refetch whenever the tab becomes active or the include-archived flag
  // toggles. The early return at the bottom of the component keeps render
  // gated, but the effect still needs to fire so re-entering the tab pulls
  // fresh data.
  useEffect(() => {
    if (!isActiveTab) return;
    let cancelled = false;
    setLoading(true);
    listSuppliers(token, includeArchived)
      .then((rows) => {
        if (!cancelled) setSuppliers(rows);
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message ?? "Failed to load suppliers");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isActiveTab, includeArchived, token, setError]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return suppliers;
    return suppliers.filter((row) => {
      const haystack = [
        row.name,
        row.short_name ?? "",
        row.contact_person ?? "",
        row.email ?? "",
        row.order_email ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [search, suppliers]);

  if (!isActiveTab) return null;

  // ── Modal handlers ─────────────────────────────────────────────────────

  const openCreateModal = () => {
    setEditing(null);
    setForm(EMPTY_SUPPLIER_FORM);
    setModalOpen(true);
  };

  const openEditModal = (supplier: WerkstattSupplier) => {
    setEditing(supplier);
    setForm(formStateFromSupplier(supplier));
    setModalOpen(true);
    setMenuOpenId(null);
  };

  const closeModal = () => {
    if (submitting) return;
    setModalOpen(false);
    setEditing(null);
    setForm(EMPTY_SUPPLIER_FORM);
  };

  const onFieldChange = (field: keyof SupplierFormState) =>
    (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      setForm((prev) => ({ ...prev, [field]: event.target.value }));
    };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canManage) return;
    if (form.name.trim() === "") {
      setError(de ? "Name ist erforderlich." : "Name is required.");
      return;
    }
    setSubmitting(true);
    try {
      const payload = payloadFromForm(form);
      if (editing) {
        const updated = await updateSupplier(token, editing.id, payload);
        setSuppliers((prev) =>
          prev.map((row) => (row.id === updated.id ? updated : row)),
        );
        setNotice(
          de ? `Lieferant aktualisiert: ${updated.name}` : `Supplier updated: ${updated.name}`,
        );
      } else {
        const created = await createSupplier(token, payload);
        setSuppliers((prev) => [...prev, created]);
        setNotice(
          de ? `Lieferant angelegt: ${created.name}` : `Supplier created: ${created.name}`,
        );
      }
      setModalOpen(false);
      setEditing(null);
      setForm(EMPTY_SUPPLIER_FORM);
    } catch (err: any) {
      setError(err?.message ?? (de ? "Speichern fehlgeschlagen" : "Save failed"));
    } finally {
      setSubmitting(false);
    }
  };

  const onArchive = async (supplier: WerkstattSupplier) => {
    if (!canManage) return;
    setMenuOpenId(null);
    const confirmed = window.confirm(
      de
        ? `Lieferant archivieren?\n\n${supplier.name}\n\nFrühere Bestellungen bleiben erhalten.`
        : `Archive this supplier?\n\n${supplier.name}\n\nPast orders remain intact.`,
    );
    if (!confirmed) return;
    try {
      await archiveSupplier(token, supplier.id);
      setSuppliers((prev) =>
        prev.map((row) =>
          row.id === supplier.id ? { ...row, is_archived: true } : row,
        ),
      );
      setNotice(
        de ? `Lieferant archiviert: ${supplier.name}` : `Supplier archived: ${supplier.name}`,
      );
    } catch (err: any) {
      setError(err?.message ?? (de ? "Archivieren fehlgeschlagen" : "Archive failed"));
    }
  };

  const onUnarchive = async (supplier: WerkstattSupplier) => {
    if (!canManage) return;
    setMenuOpenId(null);
    try {
      const updated = await updateSupplier(token, supplier.id, { is_archived: false });
      setSuppliers((prev) => prev.map((row) => (row.id === updated.id ? updated : row)));
      setNotice(
        de ? `Lieferant reaktiviert: ${updated.name}` : `Supplier restored: ${updated.name}`,
      );
    } catch (err: any) {
      setError(err?.message ?? (de ? "Reaktivieren fehlgeschlagen" : "Unarchive failed"));
    }
  };

  return (
    <section className="werkstatt-tab-page">
      <header className="werkstatt-sub-head">
        <div className="werkstatt-sub-head-text">
          <span className="werkstatt-sub-breadcrumb">
            {de ? "WERKSTATT › LIEFERANTEN" : "WORKSHOP › SUPPLIERS"}
          </span>
          <h1 className="werkstatt-sub-title">
            {de ? "Lieferanten" : "Suppliers"}
          </h1>
          <p className="werkstatt-sub-subtitle">
            {de
              ? "Partner für Datanorm-Importe und Nachbestellungen verwalten."
              : "Manage partners for Datanorm imports and reordering."}
          </p>
        </div>
        <div className="werkstatt-sub-actions">
          {canManage && (
            <button
              type="button"
              className="werkstatt-action-btn werkstatt-action-btn--primary"
              onClick={openCreateModal}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              {de ? "Neuer Lieferant" : "New supplier"}
            </button>
          )}
        </div>
      </header>

      <div className="werkstatt-filter-bar werkstatt-filter-bar--slim">
        <div className="werkstatt-search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="11" cy="11" r="6.3" stroke="#5C7895" strokeWidth="1.8" />
            <path d="m15.6 15.6 4 4" stroke="#5C7895" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={de ? "Lieferant suchen…" : "Search supplier…"}
          />
        </div>
        <label className="werkstatt-filter-toggle">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
          />
          {de ? "Archivierte anzeigen" : "Show archived"}
        </label>
      </div>

      <div className="werkstatt-table-card">
        <div className="werkstatt-table-head werkstatt-table-head--suppliers" role="row">
          <span className="werkstatt-col">{de ? "NAME" : "NAME"}</span>
          <span className="werkstatt-col">{de ? "KONTAKT" : "CONTACT"}</span>
          <span className="werkstatt-col">{de ? "LIEFERZEIT" : "LEAD TIME"}</span>
          <span className="werkstatt-col werkstatt-col--right">{de ? "ARTIKEL" : "ITEMS"}</span>
          <span className="werkstatt-col werkstatt-col--right">
            {de ? "LETZTE BEST." : "LAST ORDER"}
          </span>
          <span className="werkstatt-col werkstatt-col-actions" />
        </div>
        <ul className="werkstatt-table-body">
          {loading && filtered.length === 0 && (
            <li className="werkstatt-row werkstatt-row--empty muted">
              {de ? "Lade Lieferanten…" : "Loading suppliers…"}
            </li>
          )}
          {filtered.map((supplier) => (
            <li
              key={supplier.id}
              className={`werkstatt-row werkstatt-row--suppliers${
                supplier.is_archived ? " werkstatt-row--archived" : ""
              }`}
              role="row"
              style={supplier.is_archived ? { opacity: 0.55 } : undefined}
            >
              <span className="werkstatt-col">
                <span className="werkstatt-supplier-name">
                  <span className="werkstatt-supplier-chip" aria-hidden="true">
                    {supplier.name.slice(0, 1).toUpperCase()}
                  </span>
                  <b>{supplier.name}</b>
                  {supplier.is_archived && (
                    <small className="muted" style={{ marginLeft: 8 }}>
                      {de ? "(archiviert)" : "(archived)"}
                    </small>
                  )}
                </span>
              </span>
              <span className="werkstatt-col">
                <span className="werkstatt-row-main">
                  <b className="werkstatt-row-name">
                    {supplier.contact_person || (de ? "—" : "—")}
                  </b>
                  <small className="werkstatt-row-meta">
                    {supplier.email || supplier.order_email || (de ? "Keine E-Mail" : "No email")}
                  </small>
                </span>
              </span>
              <span className="werkstatt-col">
                {supplier.default_lead_time_days != null
                  ? de
                    ? `${supplier.default_lead_time_days} Werktage`
                    : `${supplier.default_lead_time_days} business days`
                  : de
                    ? "—"
                    : "—"}
              </span>
              <span className="werkstatt-col werkstatt-col--right">
                {supplier.article_count.toLocaleString(de ? "de-DE" : "en-US")}
              </span>
              <span className="werkstatt-col werkstatt-col--right">
                {formatLastOrderAt(supplier.last_order_at, de)}
              </span>
              <span
                className="werkstatt-col werkstatt-col-actions"
                style={{ position: "relative" }}
              >
                {canManage && (
                  <button
                    type="button"
                    className="werkstatt-row-overflow"
                    aria-label={de ? "Mehr Aktionen" : "More actions"}
                    aria-expanded={menuOpenId === supplier.id}
                    onClick={() =>
                      setMenuOpenId(menuOpenId === supplier.id ? null : supplier.id)
                    }
                  >
                    …
                  </button>
                )}
                {menuOpenId === supplier.id && (
                  <div
                    role="menu"
                    style={{
                      position: "absolute",
                      right: 0,
                      top: "100%",
                      background: "var(--surface, #fff)",
                      border: "1px solid var(--border, #ddd)",
                      borderRadius: 6,
                      boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
                      padding: 4,
                      minWidth: 180,
                      zIndex: 20,
                    }}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      className="werkstatt-row-menu-item"
                      onClick={() => openEditModal(supplier)}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        padding: "8px 12px",
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                      }}
                    >
                      {de ? "Bearbeiten" : "Edit"}
                    </button>
                    {!supplier.is_archived ? (
                      <button
                        type="button"
                        role="menuitem"
                        className="werkstatt-row-menu-item"
                        onClick={() => void onArchive(supplier)}
                        style={{
                          display: "block",
                          width: "100%",
                          textAlign: "left",
                          padding: "8px 12px",
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          color: "var(--danger, #b00020)",
                        }}
                      >
                        {de ? "Archivieren" : "Archive"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        role="menuitem"
                        className="werkstatt-row-menu-item"
                        onClick={() => void onUnarchive(supplier)}
                        style={{
                          display: "block",
                          width: "100%",
                          textAlign: "left",
                          padding: "8px 12px",
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                        }}
                      >
                        {de ? "Reaktivieren" : "Restore"}
                      </button>
                    )}
                  </div>
                )}
              </span>
            </li>
          ))}
          {filtered.length === 0 && !loading && (
            <li className="werkstatt-row werkstatt-row--empty muted">
              {suppliers.length === 0
                ? de
                  ? "Noch keine Lieferanten angelegt."
                  : "No suppliers yet."
                : de
                  ? "Keine Lieferanten gefunden."
                  : "No suppliers found."}
            </li>
          )}
        </ul>
      </div>

      {modalOpen && (
        <LieferantFormModal
          de={de}
          editing={editing}
          form={form}
          onFieldChange={onFieldChange}
          onCancel={closeModal}
          onSubmit={onSubmit}
          submitting={submitting}
        />
      )}
    </section>
  );
}
