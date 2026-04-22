import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppContext } from "../../context/AppContext";
import {
  commitImport,
  listHistory,
  listSuppliers,
  previewUpload,
  type DatanormImportPreview,
  type DatanormImportRecord,
  type WerkstattSupplier,
} from "../../utils/datanormApi";

/**
 * WerkstattDatanormImportPage — two-column admin page. Ported from Paper
 * B8X-0. Left column: supplier picker + file drop zone. Right column:
 * live preview card (row counts, conflicts). Below: "Letzte Imports" table.
 *
 * This view is admin-only. It self-gates on werkstattTab plus the
 * werkstatt:manage permission enforced by the backend on upload/commit/
 * history endpoints.
 *
 * Flow:
 *   1. Supplier dropdown + file picker + "Vorschau analysieren" button
 *   2. → POST /werkstatt/datanorm/upload returns a preview with import_token
 *   3. Preview card renders rows_new / rows_updated / rows_unchanged / conflicts
 *   4. "Import starten" → POST /werkstatt/datanorm/commit replaces this
 *      supplier's Werkstatt catalog entries atomically and writes an audit
 *   5. "Letzte Imports" refreshes from /werkstatt/datanorm/history
 */
export function WerkstattDatanormImportPage() {
  const {
    mainView,
    language,
    werkstattTab,
    setWerkstattTab,
    setNotice,
    setError,
    token,
  } = useAppContext();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [suppliers, setSuppliers] = useState<WerkstattSupplier[]>([]);
  const [suppliersLoading, setSuppliersLoading] = useState(false);
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [preview, setPreview] = useState<DatanormImportPreview | null>(null);
  const [uploading, setUploading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [history, setHistory] = useState<DatanormImportRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const isActive = mainView === "werkstatt" && werkstattTab === "datanorm_import";
  const de = language === "de";

  /* ── Load suppliers + history on tab open ─────────────────────────── */
  const reloadHistory = useCallback(async () => {
    if (!token) return;
    setHistoryLoading(true);
    try {
      const rows = await listHistory(token);
      setHistory(rows);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(
        message ||
          (de ? "Import-Verlauf konnte nicht geladen werden." : "Could not load import history."),
      );
    } finally {
      setHistoryLoading(false);
    }
  }, [token, de, setError]);

  useEffect(() => {
    if (!isActive || !token) return;
    let cancelled = false;
    setSuppliersLoading(true);
    listSuppliers(token, false)
      .then((rows) => {
        if (cancelled) return;
        setSuppliers(rows);
        // Auto-pick the first supplier when nothing's selected yet.
        setSupplierId((current) => current ?? rows[0]?.id ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(
          message ||
            (de ? "Lieferanten konnten nicht geladen werden." : "Could not load suppliers."),
        );
      })
      .finally(() => {
        if (!cancelled) setSuppliersLoading(false);
      });
    void reloadHistory();
    return () => {
      cancelled = true;
    };
  }, [isActive, token, de, reloadHistory, setError]);

  const supplier = useMemo<WerkstattSupplier | null>(
    () => suppliers.find((s) => s.id === supplierId) ?? null,
    [suppliers, supplierId],
  );

  if (!isActive) return null;

  /* ── Handlers ─────────────────────────────────────────────────────── */

  function clearAfterUpload() {
    setFile(null);
    setPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    const dropped = event.dataTransfer.files[0];
    if (dropped) {
      setFile(dropped);
      setPreview(null);
    }
  }

  function handleFileClick() {
    fileInputRef.current?.click();
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0];
    if (picked) {
      setFile(picked);
      setPreview(null);
    }
  }

  async function handleAnalyse() {
    if (!file || supplierId == null || !token) return;
    setUploading(true);
    try {
      const result = await previewUpload(token, supplierId, file);
      setPreview(result);
      setNotice(
        de
          ? `Vorschau fertig: ${result.total_rows} Artikel erkannt.`
          : `Preview ready: ${result.total_rows} items detected.`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(
        message ||
          (de ? "Vorschau fehlgeschlagen." : "Preview failed."),
      );
    } finally {
      setUploading(false);
    }
  }

  async function handleCommit(replaceMode: boolean) {
    if (!preview || !token) return;
    setCommitting(true);
    try {
      const record = await commitImport(token, preview.import_token, replaceMode);
      setNotice(
        de
          ? `Import abgeschlossen: ${record.rows_new} neu, ${record.rows_updated} aktualisiert (${record.supplier_name}).`
          : `Import complete: ${record.rows_new} new, ${record.rows_updated} updated (${record.supplier_name}).`,
      );
      clearAfterUpload();
      await reloadHistory();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(
        message ||
          (de ? "Import fehlgeschlagen." : "Import failed."),
      );
    } finally {
      setCommitting(false);
    }
  }

  /* ── Derived preview-row presentations ────────────────────────────── */

  const canAnalyse = !!file && supplierId != null && !uploading;
  const canCommit = !!preview && !committing;

  return (
    <section className="werkstatt-tab-page">
      <header className="werkstatt-sub-head">
        <div className="werkstatt-sub-head-text">
          <span className="werkstatt-sub-breadcrumb">
            {de
              ? "WERKSTATT › ADMINISTRATION › DATANORM IMPORT"
              : "WORKSHOP › ADMINISTRATION › DATANORM IMPORT"}
          </span>
          <h1 className="werkstatt-sub-title">
            {de ? "Datanorm importieren" : "Import Datanorm"}
          </h1>
          <p className="werkstatt-sub-subtitle">
            {de
              ? "Aktualisiere den Produktkatalog eines Lieferanten. Bestehende Einträge dieses Lieferanten werden ersetzt — andere Lieferanten bleiben unverändert."
              : "Update a supplier's product catalog. Existing entries for that supplier are replaced — other suppliers remain unchanged."}
          </p>
        </div>
        <div className="werkstatt-sub-actions">
          <button
            type="button"
            className="werkstatt-action-btn"
            onClick={() => {
              clearAfterUpload();
              setWerkstattTab("dashboard");
            }}
          >
            {de ? "Abbrechen" : "Cancel"}
          </button>
          <button
            type="button"
            className="werkstatt-action-btn"
            onClick={() => void reloadHistory()}
            disabled={historyLoading}
          >
            {historyLoading
              ? de ? "Lade…" : "Loading…"
              : de ? "Import-Verlauf aktualisieren" : "Refresh import history"}
          </button>
        </div>
      </header>

      <div className="werkstatt-datanorm-grid">
        <div className="werkstatt-datanorm-left">
          <section className="werkstatt-card werkstatt-datanorm-step">
            <header className="werkstatt-card-head">
              <div className="werkstatt-card-title-block">
                <span className="werkstatt-step-dot">1</span>
                <h3 className="werkstatt-card-title">
                  {de ? "Lieferant auswählen" : "Choose supplier"}
                </h3>
              </div>
            </header>
            <label className="werkstatt-field">
              <span className="werkstatt-field-label">
                {de ? "Welcher Lieferant?" : "Which supplier?"}
              </span>
              <select
                value={supplierId ?? ""}
                onChange={(event) =>
                  setSupplierId(event.target.value ? Number(event.target.value) : null)
                }
                className="werkstatt-field-select"
                disabled={suppliersLoading || suppliers.length === 0}
              >
                {suppliers.length === 0 && (
                  <option value="">
                    {suppliersLoading
                      ? de ? "Lade Lieferanten…" : "Loading suppliers…"
                      : de ? "Noch keine Lieferanten angelegt" : "No suppliers yet"}
                  </option>
                )}
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.default_lead_time_days != null
                      ? ` — ${s.default_lead_time_days} ${de ? "Werktage" : "days"}`
                      : ""}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="werkstatt-link-btn"
              onClick={() => setWerkstattTab("lieferanten")}
            >
              + {de ? "Neuen Lieferanten anlegen" : "Create new supplier"}
            </button>
          </section>

          <section className="werkstatt-card werkstatt-datanorm-step">
            <header className="werkstatt-card-head">
              <div className="werkstatt-card-title-block">
                <span className="werkstatt-step-dot">2</span>
                <h3 className="werkstatt-card-title">
                  {de ? "Datanorm-Datei" : "Datanorm file"}
                </h3>
              </div>
            </header>
            <div
              className={`werkstatt-dropzone${isDragging ? " werkstatt-dropzone--drag" : ""}`}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              onClick={handleFileClick}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  handleFileClick();
                }
              }}
            >
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M12 16V4M6 10l6-6 6 6M4 20h16"
                  stroke="#2F70B7"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <b>
                {de ? "Datei ablegen oder auswählen" : "Drop file or choose"}
              </b>
              <small>.ENP, .001, .002, .DNF · max. 25 MB</small>
              <input
                ref={fileInputRef}
                type="file"
                accept=".enp,.001,.002,.dnf,application/octet-stream,text/plain"
                onChange={handleFileChange}
                hidden
              />
            </div>
            {file && (
              <div className="werkstatt-file-chip">
                <span className="werkstatt-file-chip-icon" aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"
                      stroke="#5C7895"
                      strokeWidth="1.6"
                    />
                    <path d="M14 3v5h5" stroke="#5C7895" strokeWidth="1.6" />
                  </svg>
                </span>
                <span className="werkstatt-file-chip-main">
                  <b>{file.name}</b>
                  <small>
                    {(file.size / 1024 / 1024).toFixed(1)} MB ·{" "}
                    {preview
                      ? de ? "Vorschau bereit" : "preview ready"
                      : de ? "bereit zur Analyse" : "ready to analyse"}
                  </small>
                </span>
                <button
                  type="button"
                  className="werkstatt-file-chip-remove"
                  onClick={(event) => {
                    event.stopPropagation();
                    clearAfterUpload();
                  }}
                  aria-label={de ? "Datei entfernen" : "Remove file"}
                >
                  ✕
                </button>
              </div>
            )}
            <div className="werkstatt-datanorm-actions">
              <button
                type="button"
                className="werkstatt-action-btn werkstatt-action-btn--primary"
                disabled={!canAnalyse}
                onClick={() => void handleAnalyse()}
              >
                {uploading
                  ? de ? "Analysiere…" : "Analysing…"
                  : de ? "Vorschau analysieren" : "Analyse preview"}
              </button>
            </div>
          </section>
        </div>

        <div className="werkstatt-datanorm-right">
          <section className="werkstatt-card werkstatt-datanorm-preview">
            <header className="werkstatt-card-head">
              <div className="werkstatt-card-title-block">
                <span className="werkstatt-sub-breadcrumb">
                  {de ? "VORSCHAU" : "PREVIEW"}
                </span>
                <h3 className="werkstatt-card-title">
                  {preview
                    ? de
                      ? `${preview.total_rows.toLocaleString("de-DE")} Artikel erkannt`
                      : `${preview.total_rows.toLocaleString("en-US")} items detected`
                    : de ? "Noch keine Datei analysiert" : "No file analysed yet"}
                </h3>
              </div>
              {preview && (
                <span className="werkstatt-preview-badge">
                  <span className="werkstatt-preview-badge-dot" aria-hidden="true" />
                  {de ? "Bereit" : "Ready"}
                </span>
              )}
            </header>

            {preview ? (
              <>
                <div className="werkstatt-preview-meta-grid">
                  <div className="werkstatt-preview-meta">
                    <span className="werkstatt-preview-meta-label">
                      {de ? "Version" : "Version"}
                    </span>
                    <b>{preview.detected_version ?? "—"}</b>
                  </div>
                  <div className="werkstatt-preview-meta">
                    <span className="werkstatt-preview-meta-label">
                      {de ? "Codierung" : "Encoding"}
                    </span>
                    <b>{preview.detected_encoding ?? "—"}</b>
                  </div>
                  <div className="werkstatt-preview-meta">
                    <span className="werkstatt-preview-meta-label">
                      {de ? "Lieferant" : "Supplier"}
                    </span>
                    <b>{preview.supplier_name}</b>
                  </div>
                </div>

                <ul className="werkstatt-preview-rows">
                  <li className="werkstatt-preview-row werkstatt-preview-row--ok">
                    <span className="werkstatt-preview-row-icon" aria-hidden="true">+</span>
                    <span className="werkstatt-preview-row-main">
                      <b>{de ? "Neu" : "New"}</b>
                      <small>{de ? "noch nicht im Bestand" : "not in stock yet"}</small>
                    </span>
                    <span className="werkstatt-preview-row-count">{preview.rows_new}</span>
                  </li>
                  <li className="werkstatt-preview-row werkstatt-preview-row--info">
                    <span className="werkstatt-preview-row-icon" aria-hidden="true">↺</span>
                    <span className="werkstatt-preview-row-main">
                      <b>{de ? "Aktualisiert" : "Updated"}</b>
                      <small>
                        {de ? "Preis oder Bezeichnung geändert" : "price or name changed"}
                      </small>
                    </span>
                    <span className="werkstatt-preview-row-count">{preview.rows_updated}</span>
                  </li>
                  <li className="werkstatt-preview-row">
                    <span className="werkstatt-preview-row-icon" aria-hidden="true">−</span>
                    <span className="werkstatt-preview-row-main">
                      <b>{de ? "Unverändert" : "Unchanged"}</b>
                      <small>{de ? "werden übersprungen" : "will be skipped"}</small>
                    </span>
                    <span className="werkstatt-preview-row-count">{preview.rows_unchanged}</span>
                  </li>
                  {preview.ean_conflicts.length > 0 && (
                    <li className="werkstatt-preview-row werkstatt-preview-row--warn">
                      <span className="werkstatt-preview-row-icon" aria-hidden="true">⚠</span>
                      <span className="werkstatt-preview-row-main">
                        <b>{de ? "Konflikte" : "Conflicts"}</b>
                        <small>
                          {de
                            ? "EAN bereits bei anderem Lieferanten"
                            : "EAN already at a different supplier"}
                        </small>
                      </span>
                      <span className="werkstatt-preview-row-count">
                        {preview.ean_conflicts.length}
                      </span>
                    </li>
                  )}
                </ul>

                {preview.ean_conflicts.length > 0 && (
                  <div className="werkstatt-preview-conflicts">
                    <b>
                      {de ? "Konflikte prüfen" : "Review conflicts"} ·{" "}
                      <span className="muted">
                        {Math.min(3, preview.ean_conflicts.length)} {de ? "von" : "of"}{" "}
                        {preview.ean_conflicts.length}
                      </span>
                    </b>
                    <ul>
                      {preview.ean_conflicts.slice(0, 3).map((c) => (
                        <li key={c.ean}>
                          EAN {c.ean} · {c.item_name}
                          {c.existing_supplier_name
                            ? de
                              ? ` — Konflikt mit ${c.existing_supplier_name}`
                              : ` — conflict with ${c.existing_supplier_name}`
                            : ""}
                          {c.existing_article_no ? ` (#${c.existing_article_no})` : ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="werkstatt-preview-cta">
                  <button
                    type="button"
                    className="werkstatt-action-btn"
                    onClick={clearAfterUpload}
                    disabled={committing}
                  >
                    {de ? "Abbrechen" : "Cancel"}
                  </button>
                  <button
                    type="button"
                    className="werkstatt-action-btn werkstatt-action-btn--primary"
                    disabled={!canCommit}
                    onClick={() => void handleCommit(true)}
                  >
                    {committing
                      ? de ? "Import läuft…" : "Importing…"
                      : de
                        ? `✓ Import starten · ${preview.total_rows.toLocaleString("de-DE")} Artikel · ${preview.supplier_name}`
                        : `✓ Start import · ${preview.total_rows.toLocaleString("en-US")} items · ${preview.supplier_name}`}
                  </button>
                </div>
              </>
            ) : (
              <p className="muted" style={{ padding: "16px 0" }}>
                {de
                  ? "Wähle oben einen Lieferanten und eine Datei aus, dann klicke auf „Vorschau analysieren“."
                  : "Pick a supplier and file above, then click \"Analyse preview\"."}
                {supplier && !supplier.article_count
                  ? de
                    ? ` Für diesen Lieferanten ist aktuell kein Katalog hinterlegt (${supplier.name}).`
                    : ` No catalogue is currently stored for this supplier (${supplier.name}).`
                  : ""}
              </p>
            )}
          </section>
        </div>
      </div>

      <section className="werkstatt-card werkstatt-datanorm-history">
        <header className="werkstatt-card-head">
          <div className="werkstatt-card-title-block">
            <h3 className="werkstatt-card-title">
              {de ? "Letzte Imports" : "Recent imports"}
            </h3>
            <span className="werkstatt-card-subtitle">
              {historyLoading
                ? de ? "Lade Verlauf…" : "Loading history…"
                : history.length === 0
                  ? de ? "Noch keine Imports vorhanden." : "No imports yet."
                  : de
                    ? `${history.length} Imports insgesamt`
                    : `${history.length} imports total`}
            </span>
          </div>
        </header>
        {history.length > 0 && (
          <>
            <div className="werkstatt-table-head werkstatt-table-head--imports" role="row">
              <span className="werkstatt-col">{de ? "ZEITPUNKT" : "WHEN"}</span>
              <span className="werkstatt-col">{de ? "LIEFERANT" : "SUPPLIER"}</span>
              <span className="werkstatt-col">{de ? "DATEI" : "FILE"}</span>
              <span className="werkstatt-col">{de ? "ANZAHL" : "COUNT"}</span>
              <span className="werkstatt-col">{de ? "ERGEBNIS" : "RESULT"}</span>
              <span className="werkstatt-col werkstatt-col-actions" />
            </div>
            <ul className="werkstatt-table-body">
              {history.slice(0, 20).map((row) => (
                <li
                  key={row.id}
                  className="werkstatt-row werkstatt-row--imports"
                  role="row"
                >
                  <span className="werkstatt-col">
                    <b className="werkstatt-row-name">{formatWhen(row.started_at, de)}</b>
                    <small className="werkstatt-row-meta">
                      {row.created_by_name ? `${de ? "durch" : "by"} ${row.created_by_name}` : ""}
                    </small>
                  </span>
                  <span className="werkstatt-col">{row.supplier_name}</span>
                  <span className="werkstatt-col werkstatt-col-mono">{row.filename}</span>
                  <span className="werkstatt-col">
                    {row.total_rows.toLocaleString(de ? "de-DE" : "en-US")}
                  </span>
                  <span className="werkstatt-col">
                    <span
                      className={`werkstatt-import-tag werkstatt-import-tag--${outcomeVariant(row)}`}
                    >
                      {outcomeLabel(row, de)}
                    </span>
                  </span>
                  <span className="werkstatt-col werkstatt-col-actions" />
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </section>
  );
}

/* ── helpers ─────────────────────────────────────────────────────────── */

function formatWhen(iso: string, de: boolean): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(de ? "de-DE" : "en-US", {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

function outcomeVariant(row: DatanormImportRecord): "ok" | "warn" | "error" {
  if (row.status === "failed") return "error";
  if (row.rows_failed > 0) return "warn";
  return "ok";
}

function outcomeLabel(row: DatanormImportRecord, de: boolean): string {
  if (row.status === "failed") return de ? "Fehlgeschlagen" : "Failed";
  if (row.status === "pending") return de ? "Offen" : "Pending";
  if (row.status === "in_progress") return de ? "Läuft" : "Running";
  if (row.rows_failed > 0)
    return de
      ? `Teilweise (${row.rows_failed} Fehler)`
      : `Partial (${row.rows_failed} errors)`;
  return de
    ? `${row.rows_new} neu · ${row.rows_updated} akt.`
    : `${row.rows_new} new · ${row.rows_updated} upd.`;
}
