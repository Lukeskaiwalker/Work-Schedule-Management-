import { useRef, useState } from "react";
import { useAppContext } from "../../context/AppContext";
import {
  MOCK_DATANORM_IMPORTS,
  MOCK_SUPPLIERS,
} from "../../components/werkstatt/mockData";

/**
 * WerkstattDatanormImportPage — two-column admin page. Ported from Paper
 * B8X-0. Left column: supplier combobox + file drop zone. Right column:
 * live preview card (row counts, conflicts). Below: "Letzte Imports" table.
 *
 * This view is admin-only. It self-gates on werkstattTab plus the
 * werkstatt:manage stub permission from WerkstattBanner. All mutators are
 * visual placeholders — TODO(werkstatt): wire to /api/werkstatt/datanorm/*
 * once the Desktop BE endpoints land.
 */
export function WerkstattDatanormImportPage() {
  const { mainView, language, werkstattTab, setWerkstattTab, setNotice } = useAppContext();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [supplierId, setSupplierId] = useState<string>("s1");
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  if (mainView !== "werkstatt" || werkstattTab !== "datanorm_import") return null;

  const de = language === "de";
  const supplier = MOCK_SUPPLIERS.find((s) => s.id === supplierId) ?? MOCK_SUPPLIERS[0];

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    const dropped = event.dataTransfer.files[0];
    if (dropped) setFile(dropped);
  }

  function handleFileClick() {
    fileInputRef.current?.click();
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0];
    if (picked) setFile(picked);
  }

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
            onClick={() => setWerkstattTab("dashboard")}
          >
            {de ? "Abbrechen" : "Cancel"}
          </button>
          <button
            type="button"
            className="werkstatt-action-btn"
            onClick={() =>
              setNotice(
                de
                  ? "Import-Verlauf folgt — Endpoint: GET /api/werkstatt/datanorm/history"
                  : "Import history coming soon — endpoint: GET /api/werkstatt/datanorm/history",
              )
            }
          >
            {de ? "Import-Verlauf" : "Import history"}
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
                value={supplierId}
                onChange={(event) => setSupplierId(event.target.value)}
                className="werkstatt-field-select"
              >
                {MOCK_SUPPLIERS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} — {s.lead_time_days} {de ? "Werktage" : "days"}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="werkstatt-link-btn"
              onClick={() => {
                setWerkstattTab("lieferanten");
              }}
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
              <small>.ENP, .001, .002, .DNF · max. 50 MB</small>
              <input
                ref={fileInputRef}
                type="file"
                accept=".enp,.001,.002,.dnf"
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
                    {de ? "hochgeladen soeben" : "uploaded just now"}
                  </small>
                </span>
                <button
                  type="button"
                  className="werkstatt-file-chip-remove"
                  onClick={() => setFile(null)}
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
                disabled={!file}
                onClick={() =>
                  setNotice(
                    de
                      ? `Vorschau für "${file?.name ?? ""}" wird berechnet (API folgt)`
                      : `Analysing preview for "${file?.name ?? ""}" (API pending)`,
                  )
                }
              >
                {de ? "Vorschau analysieren" : "Analyse preview"}
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
                  {de ? "1.247 Artikel erkannt" : "1,247 items detected"}
                </h3>
              </div>
              <span className="werkstatt-preview-badge">
                <span className="werkstatt-preview-badge-dot" aria-hidden="true" />
                {de ? "Bereit" : "Ready"}
              </span>
            </header>

            <div className="werkstatt-preview-meta-grid">
              <div className="werkstatt-preview-meta">
                <span className="werkstatt-preview-meta-label">
                  {de ? "Version" : "Version"}
                </span>
                <b>Datanorm 4</b>
              </div>
              <div className="werkstatt-preview-meta">
                <span className="werkstatt-preview-meta-label">
                  {de ? "Codierung" : "Encoding"}
                </span>
                <b>UTF-8</b>
              </div>
              <div className="werkstatt-preview-meta">
                <span className="werkstatt-preview-meta-label">
                  {de ? "Währung" : "Currency"}
                </span>
                <b>EUR · {de ? "netto" : "net"}</b>
              </div>
            </div>

            <ul className="werkstatt-preview-rows">
              <li className="werkstatt-preview-row werkstatt-preview-row--ok">
                <span className="werkstatt-preview-row-icon" aria-hidden="true">+</span>
                <span className="werkstatt-preview-row-main">
                  <b>{de ? "Neu" : "New"}</b>
                  <small>{de ? "noch nicht im Bestand" : "not in stock yet"}</small>
                </span>
                <span className="werkstatt-preview-row-count">843</span>
              </li>
              <li className="werkstatt-preview-row werkstatt-preview-row--info">
                <span className="werkstatt-preview-row-icon" aria-hidden="true">↺</span>
                <span className="werkstatt-preview-row-main">
                  <b>{de ? "Aktualisiert" : "Updated"}</b>
                  <small>
                    {de ? "Preis oder Bezeichnung geändert" : "price or name changed"}
                  </small>
                </span>
                <span className="werkstatt-preview-row-count">398</span>
              </li>
              <li className="werkstatt-preview-row">
                <span className="werkstatt-preview-row-icon" aria-hidden="true">−</span>
                <span className="werkstatt-preview-row-main">
                  <b>{de ? "Unverändert" : "Unchanged"}</b>
                  <small>{de ? "werden übersprungen" : "will be skipped"}</small>
                </span>
                <span className="werkstatt-preview-row-count">0</span>
              </li>
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
                <span className="werkstatt-preview-row-count">6</span>
              </li>
            </ul>

            <div className="werkstatt-preview-conflicts">
              <b>
                {de ? "Konflikte prüfen" : "Review conflicts"} ·{" "}
                <span className="muted">3 {de ? "von" : "of"} 6</span>
              </b>
              <ul>
                <li>EAN 4059952054858 · Bosch GSR 18V-55 — Konflikt mit voestalpine Böhler (#BÖH-4521)</li>
                <li>EAN 4047254537189 · Makita Akku 18V 5,0 Ah — Konflikt mit Hoffmann Group (#HG-BL1850B)</li>
                <li>EAN 4013228201099 · Hilti TE 30 SDS-plus — Konflikt mit K+W Elektro (#KWE-HIL-TE30)</li>
              </ul>
              <button
                type="button"
                className="werkstatt-link-btn"
                onClick={() =>
                  setNotice(
                    de
                      ? "Alle Konflikte werden in einem Dialog gezeigt (folgt)"
                      : "All conflicts will open in a dialog (coming soon)",
                  )
                }
              >
                {de ? "Alle 6 Konflikte anzeigen →" : "Show all 6 conflicts →"}
              </button>
            </div>

            <div className="werkstatt-preview-cta">
              <button
                type="button"
                className="werkstatt-action-btn"
                onClick={() => {
                  setFile(null);
                  setWerkstattTab("dashboard");
                }}
              >
                {de ? "Abbrechen" : "Cancel"}
              </button>
              <button
                type="button"
                className="werkstatt-action-btn werkstatt-action-btn--primary"
                onClick={() =>
                  setNotice(
                    de
                      ? `Import gestartet für ${supplier.name} — 1.247 Artikel (API folgt)`
                      : `Import started for ${supplier.name} — 1,247 items (API pending)`,
                  )
                }
              >
                ✓ {de ? `Import starten · 1.247 Artikel · ${supplier.name}` : `Start import · 1,247 items · ${supplier.name}`}
              </button>
            </div>
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
              {de
                ? "Die letzten 4 Importe sind hier sichtbar · vollständige Historie im Import-Verlauf"
                : "The 4 most recent imports · full history in the import log"}
            </span>
          </div>
          <button type="button" className="werkstatt-card-action">
            {de ? "Alle ansehen →" : "View all →"}
          </button>
        </header>
        <div className="werkstatt-table-head werkstatt-table-head--imports" role="row">
          <span className="werkstatt-col">{de ? "ZEITPUNKT" : "WHEN"}</span>
          <span className="werkstatt-col">{de ? "LIEFERANT" : "SUPPLIER"}</span>
          <span className="werkstatt-col">{de ? "DATEI" : "FILE"}</span>
          <span className="werkstatt-col">{de ? "ANZAHL" : "COUNT"}</span>
          <span className="werkstatt-col">{de ? "ERGEBNIS" : "RESULT"}</span>
          <span className="werkstatt-col werkstatt-col-actions" />
        </div>
        <ul className="werkstatt-table-body">
          {MOCK_DATANORM_IMPORTS.map((row) => (
            <li key={row.id} className="werkstatt-row werkstatt-row--imports" role="row">
              <span className="werkstatt-col">
                <b className="werkstatt-row-name">{de ? row.when_de : row.when_en}</b>
                <small className="werkstatt-row-meta">{de ? row.sub_de : row.sub_en}</small>
              </span>
              <span className="werkstatt-col">{row.supplier}</span>
              <span className="werkstatt-col werkstatt-col-mono">{row.filename}</span>
              <span className="werkstatt-col">{row.row_count}</span>
              <span className="werkstatt-col">
                <span className={`werkstatt-import-tag werkstatt-import-tag--${row.outcome_variant}`}>
                  {row.outcome_label}
                </span>
              </span>
              <span className="werkstatt-col werkstatt-col-actions">
                <button
                  type="button"
                  className="werkstatt-row-overflow"
                  aria-label={de ? "Mehr Aktionen" : "More actions"}
                >
                  …
                </button>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}
