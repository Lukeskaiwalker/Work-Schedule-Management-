import { useEffect, useMemo, useState } from "react";

import { useAppContext } from "../../context/AppContext";
import {
  createProjectLineItem,
  listProjectLineItems,
  softDeleteProjectLineItem,
  updateProjectLineItem,
} from "../../utils/projectLineItemsApi";
import type {
  ProjectLineItem,
  ProjectLineItemCreate,
  ProjectLineItemStatus,
  ProjectLineItemType,
} from "../../types";
import { LineItemImporterModal } from "./LineItemImporterModal";


// ── Status presentation ──────────────────────────────────────────────────
//
// Maps the seven derived-status values to localized labels + a color
// class. The colors mirror the existing time-tracking absence pills
// (green = good, yellow = in-progress, red = nothing yet) so operators
// only have to learn one visual vocabulary across the app.
const STATUS_LABELS_DE: Record<ProjectLineItemStatus, string> = {
  offen: "Offen",
  teilbestellt: "Teilbestellt",
  bestellt: "Bestellt",
  teilgeliefert: "Teilgeliefert",
  vollstaendig_im_lager: "Im Lager",
  teilweise_auf_baustelle: "Teilw. Baustelle",
  vollstaendig_auf_baustelle: "Auf Baustelle",
};
const STATUS_LABELS_EN: Record<ProjectLineItemStatus, string> = {
  offen: "Open",
  teilbestellt: "Partly ordered",
  bestellt: "Ordered",
  teilgeliefert: "Partly delivered",
  vollstaendig_im_lager: "In stock",
  teilweise_auf_baustelle: "Partly on site",
  vollstaendig_auf_baustelle: "On site",
};

function statusColor(status: ProjectLineItemStatus): { bg: string; fg: string } {
  // Earlier states red-ish (nothing yet), middle states amber, completed states green.
  switch (status) {
    case "offen":
      return { bg: "#fde7e9", fg: "#a02732" };
    case "teilbestellt":
    case "bestellt":
      return { bg: "#fff7e6", fg: "#a0670c" };
    case "teilgeliefert":
    case "vollstaendig_im_lager":
      return { bg: "#edf4ff", fg: "#2861a2" };
    case "teilweise_auf_baustelle":
    case "vollstaendig_auf_baustelle":
      return { bg: "#e6f6ec", fg: "#1f6f3c" };
  }
}


const TYPE_LABELS_DE: Record<ProjectLineItemType, string> = {
  material: "Material",
  leistung: "Leistung",
  sonstige: "Sonstige",
};
const TYPE_LABELS_EN: Record<ProjectLineItemType, string> = {
  material: "Material",
  leistung: "Service",
  sonstige: "Other",
};


// ── Empty draft used by the add/edit modal ──────────────────────────────
const EMPTY_DRAFT: ProjectLineItemCreate = {
  type: "material",
  section_title: "",
  position: "",
  description: "",
  sku: "",
  manufacturer: "",
  quantity_required: "1",
  quantity_ordered: "0",
  quantity_delivered: "0",
  quantity_at_site: "0",
  quantity_reserved: "0",
  unit: "",
  unit_price_eur: "",
  total_price_eur: "",
  notes: "",
};


export function ProjectLineItemsTab() {
  const { mainView, projectTab, activeProject, token, language, setError, setNotice } =
    useAppContext();

  const de = language === "de";

  const [items, setItems] = useState<ProjectLineItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<number | "new" | null>(null);
  const [draft, setDraft] = useState<ProjectLineItemCreate>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [importerOpen, setImporterOpen] = useState(false);

  const projectId = activeProject?.id ?? null;

  // Load whenever the tab becomes active for a different project.
  useEffect(() => {
    if (mainView !== "project" || projectTab !== "line_items" || !projectId) return;
    let cancelled = false;
    setLoading(true);
    listProjectLineItems(token, projectId)
      .then((rows) => {
        if (!cancelled) setItems(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mainView, projectTab, projectId, token, setError]);

  // Group items by section for a clean visual hierarchy. Items with no
  // section land under "(ohne Titel)" — typical for manually-added rows
  // before LLM extraction is wired and for ad-hoc additions later.
  const grouped = useMemo(() => {
    const groups = new Map<string, ProjectLineItem[]>();
    for (const item of items) {
      const key = item.section_title ?? (de ? "(ohne Titel)" : "(no title)");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(item);
    }
    return Array.from(groups.entries());
  }, [items, de]);

  if (mainView !== "project" || projectTab !== "line_items" || !activeProject) {
    return null;
  }

  function openCreate() {
    setEditingId("new");
    setDraft(EMPTY_DRAFT);
  }

  function openEdit(item: ProjectLineItem) {
    setEditingId(item.id);
    setDraft({
      type: item.type,
      section_title: item.section_title ?? "",
      position: item.position ?? "",
      description: item.description,
      sku: item.sku ?? "",
      manufacturer: item.manufacturer ?? "",
      quantity_required: item.quantity_required,
      quantity_ordered: item.quantity_ordered,
      quantity_delivered: item.quantity_delivered,
      quantity_at_site: item.quantity_at_site,
      quantity_reserved: item.quantity_reserved,
      unit: item.unit ?? "",
      unit_price_eur: item.unit_price_eur ?? "",
      total_price_eur: item.total_price_eur ?? "",
      notes: item.notes ?? "",
    });
  }

  function closeEditor() {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
  }

  async function saveDraft() {
    if (!projectId) return;
    if (!draft.description.trim()) {
      setError(de ? "Bezeichnung ist erforderlich" : "Description is required");
      return;
    }
    setSaving(true);
    try {
      // Normalize: strip empty strings → null so the backend doesn't store
      // empty strings where null is the intended "no value" representation.
      const cleaned: ProjectLineItemCreate = {
        ...draft,
        description: draft.description.trim(),
        section_title: draft.section_title?.trim() || null,
        position: draft.position?.trim() || null,
        sku: draft.sku?.trim() || null,
        manufacturer: draft.manufacturer?.trim() || null,
        unit: draft.unit?.trim() || null,
        unit_price_eur: draft.unit_price_eur?.toString().trim() || null,
        total_price_eur: draft.total_price_eur?.toString().trim() || null,
        notes: draft.notes?.trim() || null,
      };
      if (editingId === "new") {
        const created = await createProjectLineItem(token, projectId, cleaned);
        setItems((current) => [...current, created]);
        setNotice(de ? "Position hinzugefügt" : "Item added");
      } else if (typeof editingId === "number") {
        const updated = await updateProjectLineItem(token, projectId, editingId, cleaned);
        setItems((current) =>
          current.map((it) => (it.id === updated.id ? updated : it)),
        );
        setNotice(de ? "Position aktualisiert" : "Item updated");
      }
      closeEditor();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function softDelete(item: ProjectLineItem) {
    if (!projectId) return;
    const ok = window.confirm(
      de
        ? `"${item.description}" wirklich entfernen?`
        : `Really remove "${item.description}"?`,
    );
    if (!ok) return;
    try {
      await softDeleteProjectLineItem(token, projectId, item.id);
      setItems((current) => current.filter((it) => it.id !== item.id));
      setNotice(de ? "Position entfernt" : "Item removed");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="project-line-items-tab" style={{ padding: "16px 0" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 16,
        }}
      >
        <h3 style={{ margin: 0 }}>
          {de ? "Positionen" : "Line items"}
          <small className="muted" style={{ marginLeft: 12, fontWeight: 400 }}>
            {items.length}{" "}
            {de
              ? items.length === 1
                ? "Position"
                : "Positionen"
              : items.length === 1
                ? "item"
                : "items"}
          </small>
        </h3>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="ghost" onClick={() => setImporterOpen(true)}>
            {de ? "Aus Beleg importieren" : "Import from document"}
          </button>
          <button type="button" onClick={openCreate}>
            {de ? "+ Position" : "+ Item"}
          </button>
        </div>
      </header>

      {loading && (
        <small className="muted">{de ? "Lade…" : "Loading…"}</small>
      )}

      {!loading && items.length === 0 && (
        <p className="muted">
          {de
            ? "Noch keine Positionen erfasst. Manuelle Eingabe über '+ Position' oder per Beleg-Import (PDF / Bild / E-Mail)."
            : "No line items yet. Add one manually with '+ Item' or import from a document (PDF / image / email)."}
        </p>
      )}

      {!loading && items.length > 0 && (
        <div className="project-line-items-table">
          {grouped.map(([sectionTitle, rows]) => (
            <div key={sectionTitle} style={{ marginBottom: 24 }}>
              <h4 style={{ margin: "12px 0 8px 0", color: "#5c7895" }}>
                {sectionTitle}
              </h4>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ textAlign: "left", fontSize: 12, color: "#8fa2ba" }}>
                    <th style={{ padding: "6px 8px" }}>Pos.</th>
                    <th style={{ padding: "6px 8px" }}>Typ</th>
                    <th style={{ padding: "6px 8px" }}>
                      {de ? "Bezeichnung" : "Description"}
                    </th>
                    <th style={{ padding: "6px 8px", textAlign: "right" }}>
                      {de ? "Menge" : "Qty"}
                    </th>
                    <th style={{ padding: "6px 8px" }}>EH</th>
                    <th style={{ padding: "6px 8px" }}>Status</th>
                    <th style={{ padding: "6px 8px", textAlign: "right" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((item) => {
                    const statusLabel = de
                      ? STATUS_LABELS_DE[item.status]
                      : STATUS_LABELS_EN[item.status];
                    const sc = statusColor(item.status);
                    return (
                      <tr
                        key={item.id}
                        style={{ borderTop: "1px solid #edf4ff", fontSize: 13 }}
                      >
                        <td style={{ padding: "8px", color: "#8fa2ba" }}>
                          {item.position ?? "—"}
                        </td>
                        <td style={{ padding: "8px" }}>
                          <small className="muted">
                            {de ? TYPE_LABELS_DE[item.type] : TYPE_LABELS_EN[item.type]}
                          </small>
                        </td>
                        <td style={{ padding: "8px" }}>
                          {item.description}
                          {item.sku && (
                            <>
                              <br />
                              <small className="muted">
                                {item.manufacturer ? `${item.manufacturer} · ` : ""}
                                {item.sku}
                              </small>
                            </>
                          )}
                        </td>
                        <td
                          style={{
                            padding: "8px",
                            textAlign: "right",
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {item.quantity_required}
                        </td>
                        <td style={{ padding: "8px" }}>{item.unit ?? ""}</td>
                        <td style={{ padding: "8px" }}>
                          <span
                            style={{
                              display: "inline-block",
                              padding: "2px 8px",
                              borderRadius: 999,
                              fontSize: 11,
                              fontWeight: 600,
                              background: sc.bg,
                              color: sc.fg,
                            }}
                          >
                            {statusLabel}
                          </span>
                        </td>
                        <td style={{ padding: "8px", textAlign: "right" }}>
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => openEdit(item)}
                            style={{ marginRight: 4 }}
                          >
                            {de ? "Bearb." : "Edit"}
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => softDelete(item)}
                            style={{ color: "#a02732" }}
                          >
                            {de ? "Löschen" : "Delete"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      {editingId !== null && (
        <LineItemEditor
          mode={editingId === "new" ? "create" : "edit"}
          draft={draft}
          onChange={setDraft}
          onSave={saveDraft}
          onCancel={closeEditor}
          saving={saving}
          language={language}
        />
      )}

      {projectId !== null && (
        <LineItemImporterModal
          projectId={projectId}
          isOpen={importerOpen}
          onClose={() => setImporterOpen(false)}
          onConfirmed={async () => {
            // Re-fetch the items list so the newly imported rows
            // appear immediately. Cheaper to refetch than to merge
            // optimistically because the section grouping needs to
            // re-sort and the backend may have done minor cleanup
            // (e.g. trimming whitespace) on what we sent.
            try {
              const fresh = await listProjectLineItems(token, projectId);
              setItems(fresh);
            } catch (err: unknown) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }}
        />
      )}
    </section>
  );
}


// ── Modal editor ────────────────────────────────────────────────────────
function LineItemEditor({
  mode,
  draft,
  onChange,
  onSave,
  onCancel,
  saving,
  language,
}: {
  mode: "create" | "edit";
  draft: ProjectLineItemCreate;
  onChange: (next: ProjectLineItemCreate) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  language: "de" | "en";
}) {
  const de = language === "de";
  const update = <K extends keyof ProjectLineItemCreate>(
    key: K,
    value: ProjectLineItemCreate[K],
  ) => onChange({ ...draft, [key]: value });

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div
        className="card modal-card"
        onMouseDown={(e) => e.stopPropagation()}
        style={{ width: "min(720px, 96vw)", padding: 24 }}
      >
        <h3 style={{ marginTop: 0 }}>
          {mode === "create"
            ? de
              ? "Neue Position"
              : "New item"
            : de
              ? "Position bearbeiten"
              : "Edit item"}
        </h3>

        {/* Row 1: type + position + section */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 2fr", gap: 12 }}>
          <label>
            <small className="muted">Typ</small>
            <select
              value={draft.type}
              onChange={(e) => update("type", e.target.value as ProjectLineItemType)}
            >
              <option value="material">{de ? "Material" : "Material"}</option>
              <option value="leistung">{de ? "Leistung" : "Service"}</option>
              <option value="sonstige">{de ? "Sonstige" : "Other"}</option>
            </select>
          </label>
          <label>
            <small className="muted">{de ? "Position" : "Position"}</small>
            <input
              value={draft.position ?? ""}
              onChange={(e) => update("position", e.target.value)}
              placeholder="01.01"
            />
          </label>
          <label>
            <small className="muted">{de ? "Abschnitt" : "Section"}</small>
            <input
              value={draft.section_title ?? ""}
              onChange={(e) => update("section_title", e.target.value)}
              placeholder={de ? "z.B. DC Montage" : "e.g. DC Mount"}
            />
          </label>
        </div>

        <label style={{ display: "block", marginTop: 12 }}>
          <small className="muted">{de ? "Bezeichnung *" : "Description *"}</small>
          <textarea
            value={draft.description}
            onChange={(e) => update("description", e.target.value)}
            rows={2}
            required
            style={{ width: "100%" }}
          />
        </label>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
          <label>
            <small className="muted">{de ? "Hersteller" : "Manufacturer"}</small>
            <input
              value={draft.manufacturer ?? ""}
              onChange={(e) => update("manufacturer", e.target.value)}
              placeholder="WINAICO"
            />
          </label>
          <label>
            <small className="muted">SKU</small>
            <input
              value={draft.sku ?? ""}
              onChange={(e) => update("sku", e.target.value)}
              placeholder="WST-485BD/X54-B2"
            />
          </label>
        </div>

        {/* Quantities row */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr",
            gap: 8,
            marginTop: 12,
          }}
        >
          <label>
            <small className="muted">{de ? "Menge *" : "Qty *"}</small>
            <input
              type="number"
              step="0.01"
              min="0"
              value={draft.quantity_required}
              onChange={(e) => update("quantity_required", e.target.value)}
              required
            />
          </label>
          <label>
            <small className="muted">{de ? "Bestellt" : "Ordered"}</small>
            <input
              type="number"
              step="0.01"
              min="0"
              value={draft.quantity_ordered ?? "0"}
              onChange={(e) => update("quantity_ordered", e.target.value)}
            />
          </label>
          <label>
            <small className="muted">{de ? "Geliefert" : "Delivered"}</small>
            <input
              type="number"
              step="0.01"
              min="0"
              value={draft.quantity_delivered ?? "0"}
              onChange={(e) => update("quantity_delivered", e.target.value)}
            />
          </label>
          <label>
            <small className="muted">{de ? "Auf Baust." : "On site"}</small>
            <input
              type="number"
              step="0.01"
              min="0"
              value={draft.quantity_at_site ?? "0"}
              onChange={(e) => update("quantity_at_site", e.target.value)}
            />
          </label>
          <label>
            <small className="muted">{de ? "Einheit" : "Unit"}</small>
            <input
              value={draft.unit ?? ""}
              onChange={(e) => update("unit", e.target.value)}
              placeholder="Stck"
            />
          </label>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
          <label>
            <small className="muted">{de ? "Einzelpreis (€)" : "Unit price (€)"}</small>
            <input
              type="number"
              step="0.01"
              min="0"
              value={draft.unit_price_eur ?? ""}
              onChange={(e) => update("unit_price_eur", e.target.value)}
            />
          </label>
          <label>
            <small className="muted">{de ? "Gesamtpreis (€)" : "Total price (€)"}</small>
            <input
              type="number"
              step="0.01"
              min="0"
              value={draft.total_price_eur ?? ""}
              onChange={(e) => update("total_price_eur", e.target.value)}
            />
          </label>
        </div>

        <label style={{ display: "block", marginTop: 12 }}>
          <small className="muted">{de ? "Notiz" : "Note"}</small>
          <textarea
            value={draft.notes ?? ""}
            onChange={(e) => update("notes", e.target.value)}
            rows={2}
            style={{ width: "100%" }}
          />
        </label>

        <footer
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 16,
          }}
        >
          <button type="button" className="ghost" onClick={onCancel} disabled={saving}>
            {de ? "Abbrechen" : "Cancel"}
          </button>
          <button type="button" onClick={onSave} disabled={saving}>
            {saving
              ? de
                ? "Speichert…"
                : "Saving…"
              : de
                ? "Speichern"
                : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}
