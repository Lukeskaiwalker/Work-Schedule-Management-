/**
 * LineItemImporterModal — v2.4.0 importer surface for ProjectLineItem.
 *
 * Three-phase flow inside one modal:
 *
 *   1. **form**     — operator picks doc type + supplies a PDF, image,
 *                     or email body, then hits "Run extraction".
 *   2. **polling**  — the modal polls the extraction job every 1.5s
 *                     while the worker runs OpenAI Structured Outputs.
 *                     Shows a spinner + live status badge.
 *   3. **review**   — once the job lands `completed`, the modal renders
 *                     an editable table of the extracted items. The
 *                     operator can edit any cell, toggle skip-per-row,
 *                     then hit "Create N items" to fire the confirm
 *                     endpoint and close the modal.
 *
 * All three phases live in this single component because the state
 * (current job, editable items) flows from one phase to the next and
 * splitting them would force an awkward parent state machine.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";

import { useAppContext } from "../../context/AppContext";
import {
  confirmLineItemExtraction,
  enqueueLineItemExtraction,
  getLineItemExtractionJob,
} from "../../utils/projectLineItemsApi";
import type {
  ExtractedLineItem,
  ExtractionConfirmItem,
  LineItemExtractionDocType,
  LineItemExtractionJob,
  ProjectLineItem,
  ProjectLineItemType,
} from "../../types";


// ── doc-type label dictionary ──────────────────────────────────────────

const DOC_TYPE_LABELS: Record<
  LineItemExtractionDocType,
  { en: string; de: string }
> = {
  auftragsbestaetigung: { en: "Order confirmation (AB)", de: "Auftragsbestätigung (AB)" },
  bestellbestaetigung: { en: "Supplier order confirmation (BB)", de: "Bestellbestätigung (BB)" },
  lieferschein: { en: "Delivery note (LS)", de: "Lieferschein (LS)" },
};


const TYPE_LABELS: Record<ProjectLineItemType, { en: string; de: string }> = {
  material: { en: "Material", de: "Material" },
  leistung: { en: "Service", de: "Leistung" },
  sonstige: { en: "Other", de: "Sonstige" },
};


// ── editable-row state ─────────────────────────────────────────────────

/** Per-row state during the review phase. ExtractedLineItem has
 *  numeric quantity/price; we keep them as strings while the operator
 *  edits so partial input ("12.5" → "12.55" → "12.55") doesn't get
 *  prematurely parsed. ``skipped`` is local-only — skipped rows are
 *  simply omitted from the confirm payload. */
type EditableRow = {
  id: number; // local index, not a backend id
  skipped: boolean;
  type: ProjectLineItemType;
  section_title: string;
  position: string;
  description: string;
  sku: string;
  manufacturer: string;
  quantity_required: string;
  unit: string;
  unit_price_eur: string;
  total_price_eur: string;
  confidence: string;
  notes: string;
};


function rowFromExtracted(item: ExtractedLineItem, index: number): EditableRow {
  return {
    id: index,
    skipped: false,
    type: item.type,
    section_title: item.section_title ?? "",
    position: item.position ?? "",
    description: item.description ?? "",
    sku: item.sku ?? "",
    manufacturer: item.manufacturer ?? "",
    quantity_required: String(item.quantity_required ?? ""),
    unit: item.unit ?? "",
    unit_price_eur: item.unit_price_eur != null ? String(item.unit_price_eur) : "",
    total_price_eur: item.total_price_eur != null ? String(item.total_price_eur) : "",
    confidence: String(item.confidence ?? ""),
    notes: "",
  };
}


function rowToConfirmItem(row: EditableRow): ExtractionConfirmItem {
  // Empty strings → null so the backend doesn't store empties where
  // null is the intended "absent value". Quantity_required is required
  // (validated upstream by the disabled-on-empty submit button).
  return {
    type: row.type,
    section_title: row.section_title.trim() || null,
    position: row.position.trim() || null,
    description: row.description.trim(),
    sku: row.sku.trim() || null,
    manufacturer: row.manufacturer.trim() || null,
    quantity_required: row.quantity_required.trim(),
    unit: row.unit.trim() || null,
    unit_price_eur: row.unit_price_eur.trim() || null,
    total_price_eur: row.total_price_eur.trim() || null,
    extraction_confidence: row.confidence.trim() || null,
    notes: row.notes.trim() || null,
  };
}


// ── component ──────────────────────────────────────────────────────────

type Props = {
  projectId: number;
  isOpen: boolean;
  onClose: () => void;
  /** Called after a successful confirm. Parent uses this to refresh
   *  its line-items list (and optionally show a success toast). */
  onConfirmed: (result: { createdCount: number; lineItemIds: number[] }) => void;
};


export function LineItemImporterModal({ projectId, isOpen, onClose, onConfirmed }: Props) {
  const { token, language, setError, setNotice } = useAppContext();
  const de = language === "de";

  type Phase = "form" | "polling" | "review";
  const [phase, setPhase] = useState<Phase>("form");

  // Form-phase state
  const [docType, setDocType] = useState<LineItemExtractionDocType>("auftragsbestaetigung");
  const [inputMode, setInputMode] = useState<"file" | "email">("file");
  const [file, setFile] = useState<File | null>(null);
  const [emailText, setEmailText] = useState("");
  const [enqueuing, setEnqueuing] = useState(false);

  // Polling/review state
  const [currentJob, setCurrentJob] = useState<LineItemExtractionJob | null>(null);
  const [editableRows, setEditableRows] = useState<EditableRow[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // Polling timer — ref so we can clear on unmount/job-change without
  // useEffect dependencies fighting each other.
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset everything when the modal opens. Without this, opening the
  // modal a second time would still show the previous job's review
  // table.
  useEffect(() => {
    if (!isOpen) return;
    setPhase("form");
    setDocType("auftragsbestaetigung");
    setInputMode("file");
    setFile(null);
    setEmailText("");
    setCurrentJob(null);
    setEditableRows([]);
    setSubmitting(false);
    setEnqueuing(false);
  }, [isOpen]);

  // Polling loop. Runs while the modal is open AND we have a queued/
  // processing job. Stops on completed | failed. Cleared on unmount or
  // when the job leaves an in-flight state.
  useEffect(() => {
    if (!currentJob || phase !== "polling") return;
    if (currentJob.status === "completed" || currentJob.status === "failed") return;

    let cancelled = false;
    function tick() {
      if (cancelled || !currentJob) return;
      getLineItemExtractionJob(token, projectId, currentJob.id)
        .then((next) => {
          if (cancelled) return;
          setCurrentJob(next);
          if (next.status === "completed") {
            setEditableRows(next.extracted_items_json.map(rowFromExtracted));
            setPhase("review");
          } else if (next.status === "failed") {
            // Stay in polling phase — UI shows error + retry.
          } else {
            // Still queued/processing — keep polling.
            pollTimerRef.current = setTimeout(tick, 1500);
          }
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
          // Stop polling on transport errors so we don't spam the user.
        });
    }
    pollTimerRef.current = setTimeout(tick, 1500);
    return () => {
      cancelled = true;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    };
  }, [currentJob, phase, token, projectId, setError]);

  // Derived value for the review-phase footer. MUST live above the
  // ``if (!isOpen) return null`` early return so the hook count stays
  // constant across renders — otherwise React error #310 fires the
  // first time the modal is opened (10 hooks pre-open, 11 post-open).
  const importableCount = useMemo(
    () => editableRows.filter((row) => !row.skipped).length,
    [editableRows],
  );

  if (!isOpen) return null;

  // ── handlers ────────────────────────────────────────────────────────

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const f = event.target.files?.[0] ?? null;
    setFile(f);
  }

  async function handleRunExtraction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (enqueuing) return;
    if (inputMode === "file" && !file) {
      setError(de ? "Bitte eine Datei auswählen" : "Please select a file");
      return;
    }
    if (inputMode === "email" && !emailText.trim()) {
      setError(de ? "E-Mail-Text ist leer" : "Email text is empty");
      return;
    }
    setEnqueuing(true);
    try {
      const response = await enqueueLineItemExtraction(token, projectId, {
        docType,
        file: inputMode === "file" ? (file ?? undefined) : undefined,
        emailText: inputMode === "email" ? emailText : undefined,
      });
      // Fetch the full job so we have all fields the polling loop
      // needs (status, extracted_items_count, etc.).
      const fullJob = await getLineItemExtractionJob(
        token,
        projectId,
        response.job_id,
      );
      setCurrentJob(fullJob);
      setPhase("polling");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setEnqueuing(false);
    }
  }

  async function handleConfirm() {
    if (!currentJob || submitting) return;
    const itemsToImport = editableRows.filter((row) => !row.skipped);
    if (itemsToImport.length === 0) {
      setError(de ? "Keine Positionen zum Importieren" : "No items to import");
      return;
    }
    setSubmitting(true);
    try {
      const result = await confirmLineItemExtraction(
        token,
        projectId,
        currentJob.id,
        itemsToImport.map(rowToConfirmItem),
      );
      setNotice(
        de
          ? `${result.created_count} Position${result.created_count === 1 ? "" : "en"} importiert`
          : `Imported ${result.created_count} item${result.created_count === 1 ? "" : "s"}`,
      );
      onConfirmed({
        createdCount: result.created_count,
        lineItemIds: result.line_item_ids,
      });
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  function updateRow(index: number, patch: Partial<EditableRow>) {
    setEditableRows((rows) =>
      rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  }

  // ── render helpers ──────────────────────────────────────────────────

  const overlayStyle: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "rgba(15, 23, 42, 0.5)",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    padding: "5vh 16px",
    zIndex: 1000,
  };
  const dialogStyle: React.CSSProperties = {
    background: "#fff",
    borderRadius: 12,
    boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
    maxWidth: phase === "review" ? 1280 : 640,
    width: "100%",
    maxHeight: "90vh",
    overflow: "auto",
    padding: 24,
  };

  return (
    <div style={overlayStyle} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={dialogStyle} role="dialog" aria-modal="true">
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h3 style={{ margin: 0 }}>
            {phase === "form" && (de ? "Beleg-Import" : "Document import")}
            {phase === "polling" && (de ? "Extraktion läuft…" : "Extraction running…")}
            {phase === "review" && (de ? "Positionen prüfen & importieren" : "Review & import items")}
          </h3>
          <button type="button" className="ghost" onClick={onClose} disabled={submitting}>
            {de ? "Schließen" : "Close"}
          </button>
        </header>

        {phase === "form" && (
          <FormPhase
            de={de}
            docType={docType}
            setDocType={setDocType}
            inputMode={inputMode}
            setInputMode={setInputMode}
            file={file}
            handleFileChange={handleFileChange}
            emailText={emailText}
            setEmailText={setEmailText}
            enqueuing={enqueuing}
            handleRunExtraction={handleRunExtraction}
          />
        )}

        {phase === "polling" && currentJob && (
          <PollingPhase
            de={de}
            job={currentJob}
            onRetry={() => setPhase("form")}
            onCancel={onClose}
          />
        )}

        {phase === "review" && currentJob && (
          <ReviewPhase
            de={de}
            job={currentJob}
            rows={editableRows}
            onRowChange={updateRow}
            importableCount={importableCount}
            submitting={submitting}
            handleConfirm={handleConfirm}
            onCancel={onClose}
          />
        )}
      </div>
    </div>
  );
}


// ── phase A: form ──────────────────────────────────────────────────────

type FormPhaseProps = {
  de: boolean;
  docType: LineItemExtractionDocType;
  setDocType: (value: LineItemExtractionDocType) => void;
  inputMode: "file" | "email";
  setInputMode: (value: "file" | "email") => void;
  file: File | null;
  handleFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  emailText: string;
  setEmailText: (value: string) => void;
  enqueuing: boolean;
  handleRunExtraction: (event: FormEvent<HTMLFormElement>) => void;
};


function FormPhase({
  de,
  docType,
  setDocType,
  inputMode,
  setInputMode,
  file,
  handleFileChange,
  emailText,
  setEmailText,
  enqueuing,
  handleRunExtraction,
}: FormPhaseProps) {
  return (
    <form onSubmit={handleRunExtraction} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <fieldset style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: 12 }}>
        <legend style={{ padding: "0 6px", fontSize: 13, color: "#475569" }}>
          {de ? "Dokumenttyp" : "Document type"}
        </legend>
        {(Object.keys(DOC_TYPE_LABELS) as LineItemExtractionDocType[]).map((value) => (
          <label key={value} style={{ display: "block", padding: "4px 0", cursor: "pointer" }}>
            <input
              type="radio"
              name="doc_type"
              value={value}
              checked={docType === value}
              onChange={() => setDocType(value)}
              style={{ marginRight: 8 }}
            />
            {de ? DOC_TYPE_LABELS[value].de : DOC_TYPE_LABELS[value].en}
          </label>
        ))}
      </fieldset>

      <fieldset style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: 12 }}>
        <legend style={{ padding: "0 6px", fontSize: 13, color: "#475569" }}>
          {de ? "Eingabe" : "Input"}
        </legend>
        <div style={{ display: "flex", gap: 16, marginBottom: 12 }}>
          <label style={{ cursor: "pointer" }}>
            <input
              type="radio"
              name="input_mode"
              value="file"
              checked={inputMode === "file"}
              onChange={() => setInputMode("file")}
              style={{ marginRight: 6 }}
            />
            {de ? "Datei (PDF / Bild)" : "File (PDF / image)"}
          </label>
          <label style={{ cursor: "pointer" }}>
            <input
              type="radio"
              name="input_mode"
              value="email"
              checked={inputMode === "email"}
              onChange={() => setInputMode("email")}
              style={{ marginRight: 6 }}
            />
            {de ? "E-Mail-Text" : "Email body"}
          </label>
        </div>

        {inputMode === "file" && (
          <div>
            <input
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.webp"
              onChange={handleFileChange}
            />
            {file && (
              <small className="muted" style={{ display: "block", marginTop: 6 }}>
                {file.name} ({Math.round(file.size / 1024)} KB)
              </small>
            )}
          </div>
        )}
        {inputMode === "email" && (
          <textarea
            value={emailText}
            onChange={(e) => setEmailText(e.target.value)}
            rows={8}
            placeholder={
              de
                ? "E-Mail-Text einfügen (max. 50.000 Zeichen)"
                : "Paste email body (max 50,000 characters)"
            }
            style={{ width: "100%", padding: 8, fontFamily: "inherit" }}
          />
        )}
      </fieldset>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button type="submit" disabled={enqueuing}>
          {enqueuing
            ? de ? "Starte…" : "Starting…"
            : de ? "Extraktion starten" : "Run extraction"}
        </button>
      </div>
    </form>
  );
}


// ── phase B: polling ──────────────────────────────────────────────────

type PollingPhaseProps = {
  de: boolean;
  job: LineItemExtractionJob;
  onRetry: () => void;
  onCancel: () => void;
};


function PollingPhase({ de, job, onRetry, onCancel }: PollingPhaseProps) {
  const isFailed = job.status === "failed";

  return (
    <div style={{ padding: "32px 8px", textAlign: "center" }}>
      <div style={{ fontSize: 14, color: "#475569", marginBottom: 8 }}>
        {de ? "Status:" : "Status:"}{" "}
        <strong>{job.status}</strong>
        {job.attempt_count > 0 && (
          <span style={{ marginLeft: 8 }}>
            ({de ? "Versuch" : "Attempt"} {job.attempt_count}/{job.max_attempts})
          </span>
        )}
      </div>
      {!isFailed && (
        <p style={{ color: "#64748b" }}>
          {de
            ? "Die Extraktion läuft im Hintergrund. Das kann je nach Dokumentgröße 5-60 Sekunden dauern."
            : "Extraction is running in the background. Expect 5-60 seconds depending on document size."}
        </p>
      )}
      {isFailed && (
        <div style={{ marginTop: 16 }}>
          <p style={{ color: "#dc2626", fontWeight: 500 }}>
            {de ? "Extraktion fehlgeschlagen" : "Extraction failed"}
          </p>
          <pre
            style={{
              fontSize: 12,
              color: "#991b1b",
              background: "#fef2f2",
              padding: 12,
              borderRadius: 6,
              textAlign: "left",
              whiteSpace: "pre-wrap",
              maxHeight: 200,
              overflow: "auto",
            }}
          >
            {job.error_message || (de ? "Unbekannter Fehler" : "Unknown error")}
          </pre>
          <div style={{ marginTop: 12, display: "flex", gap: 8, justifyContent: "center" }}>
            <button type="button" className="ghost" onClick={onCancel}>
              {de ? "Abbrechen" : "Cancel"}
            </button>
            <button type="button" onClick={onRetry}>
              {de ? "Neu starten" : "Try again"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}


// ── phase C: review ────────────────────────────────────────────────────

type ReviewPhaseProps = {
  de: boolean;
  job: LineItemExtractionJob;
  rows: EditableRow[];
  onRowChange: (index: number, patch: Partial<EditableRow>) => void;
  importableCount: number;
  submitting: boolean;
  handleConfirm: () => void;
  onCancel: () => void;
};


function ReviewPhase({
  de,
  job,
  rows,
  onRowChange,
  importableCount,
  submitting,
  handleConfirm,
  onCancel,
}: ReviewPhaseProps) {
  return (
    <div>
      <div style={{ fontSize: 13, color: "#475569", marginBottom: 12 }}>
        {de
          ? `Modell: ${job.extracted_by_model ?? "?"} · Tokens: ${job.input_tokens ?? "?"} in / ${job.output_tokens ?? "?"} out · ${rows.length} Position${rows.length === 1 ? "" : "en"} extrahiert`
          : `Model: ${job.extracted_by_model ?? "?"} · Tokens: ${job.input_tokens ?? "?"} in / ${job.output_tokens ?? "?"} out · ${rows.length} item${rows.length === 1 ? "" : "s"} extracted`}
      </div>

      <div style={{ overflowX: "auto", border: "1px solid #cbd5e1", borderRadius: 8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead style={{ background: "#f1f5f9" }}>
            <tr>
              <th style={cellStyle}>{de ? "Übern." : "Import"}</th>
              <th style={cellStyle}>{de ? "Typ" : "Type"}</th>
              <th style={cellStyle}>{de ? "Pos." : "Pos."}</th>
              <th style={{ ...cellStyle, minWidth: 220 }}>{de ? "Bezeichnung" : "Description"}</th>
              <th style={cellStyle}>SKU</th>
              <th style={cellStyle}>{de ? "Hersteller" : "Manufacturer"}</th>
              <th style={cellStyle}>{de ? "Menge" : "Qty"}</th>
              <th style={cellStyle}>{de ? "Einheit" : "Unit"}</th>
              <th style={cellStyle}>{de ? "Einzelpr." : "Unit €"}</th>
              <th style={cellStyle}>{de ? "Gesamt" : "Total €"}</th>
              <th style={cellStyle}>{de ? "Konf." : "Conf."}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const conf = parseFloat(row.confidence);
              const lowConfidence = !Number.isNaN(conf) && conf < 0.7;
              const rowStyle: React.CSSProperties = {
                opacity: row.skipped ? 0.4 : 1,
                background: lowConfidence ? "#fef9c3" : undefined,
              };
              return (
                <tr key={row.id} style={rowStyle}>
                  <td style={cellStyle}>
                    <input
                      type="checkbox"
                      checked={!row.skipped}
                      onChange={(e) => onRowChange(index, { skipped: !e.target.checked })}
                    />
                  </td>
                  <td style={cellStyle}>
                    <select
                      value={row.type}
                      onChange={(e) =>
                        onRowChange(index, { type: e.target.value as ProjectLineItemType })
                      }
                      disabled={row.skipped}
                    >
                      {(Object.keys(TYPE_LABELS) as ProjectLineItemType[]).map((value) => (
                        <option key={value} value={value}>
                          {de ? TYPE_LABELS[value].de : TYPE_LABELS[value].en}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td style={cellStyle}>
                    <CellInput
                      value={row.position}
                      disabled={row.skipped}
                      onChange={(v) => onRowChange(index, { position: v })}
                      width={70}
                    />
                  </td>
                  <td style={cellStyle}>
                    <CellInput
                      value={row.description}
                      disabled={row.skipped}
                      onChange={(v) => onRowChange(index, { description: v })}
                      width={220}
                    />
                  </td>
                  <td style={cellStyle}>
                    <CellInput
                      value={row.sku}
                      disabled={row.skipped}
                      onChange={(v) => onRowChange(index, { sku: v })}
                      width={130}
                    />
                  </td>
                  <td style={cellStyle}>
                    <CellInput
                      value={row.manufacturer}
                      disabled={row.skipped}
                      onChange={(v) => onRowChange(index, { manufacturer: v })}
                      width={120}
                    />
                  </td>
                  <td style={cellStyle}>
                    <CellInput
                      value={row.quantity_required}
                      disabled={row.skipped}
                      onChange={(v) => onRowChange(index, { quantity_required: v })}
                      width={70}
                      align="right"
                    />
                  </td>
                  <td style={cellStyle}>
                    <CellInput
                      value={row.unit}
                      disabled={row.skipped}
                      onChange={(v) => onRowChange(index, { unit: v })}
                      width={60}
                    />
                  </td>
                  <td style={cellStyle}>
                    <CellInput
                      value={row.unit_price_eur}
                      disabled={row.skipped}
                      onChange={(v) => onRowChange(index, { unit_price_eur: v })}
                      width={80}
                      align="right"
                    />
                  </td>
                  <td style={cellStyle}>
                    <CellInput
                      value={row.total_price_eur}
                      disabled={row.skipped}
                      onChange={(v) => onRowChange(index, { total_price_eur: v })}
                      width={90}
                      align="right"
                    />
                  </td>
                  <td style={{ ...cellStyle, textAlign: "right", color: lowConfidence ? "#a16207" : "#64748b" }}>
                    {row.confidence}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16 }}>
        <small className="muted">
          {de
            ? `${importableCount} von ${rows.length} Position${rows.length === 1 ? "" : "en"} werden importiert`
            : `${importableCount} of ${rows.length} item${rows.length === 1 ? "" : "s"} will be imported`}
          {rows.some((row) => parseFloat(row.confidence) < 0.7) && (
            <span style={{ marginLeft: 8, color: "#a16207" }}>
              {de
                ? "(gelb = niedrige Konfidenz, prüfen)"
                : "(yellow = low confidence, please verify)"}
            </span>
          )}
        </small>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="ghost" onClick={onCancel} disabled={submitting}>
            {de ? "Abbrechen" : "Cancel"}
          </button>
          <button type="button" onClick={handleConfirm} disabled={submitting || importableCount === 0}>
            {submitting
              ? (de ? "Importiere…" : "Importing…")
              : (de
                  ? `${importableCount} Position${importableCount === 1 ? "" : "en"} importieren`
                  : `Import ${importableCount} item${importableCount === 1 ? "" : "s"}`)}
          </button>
        </div>
      </div>
    </div>
  );
}


// ── shared cell input ─────────────────────────────────────────────────

type CellInputProps = {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  width: number;
  align?: "left" | "right";
};


function CellInput({ value, disabled, onChange, width, align = "left" }: CellInputProps) {
  return (
    <input
      type="text"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width,
        padding: "2px 4px",
        fontSize: 12,
        textAlign: align,
        border: "1px solid #e2e8f0",
        borderRadius: 4,
      }}
    />
  );
}


const cellStyle: React.CSSProperties = {
  padding: "4px 6px",
  borderBottom: "1px solid #e2e8f0",
  textAlign: "left",
  verticalAlign: "middle",
};

// Re-export for parents that want to type the callback's payload but
// don't otherwise need ProjectLineItem.
export type { ProjectLineItem };
