/**
 * What the printer reports about itself (docs/LABEL_PRINTER_CALIBRATION.md
 * §4.3, §7.6 step 1, §7.10).
 *
 * Read-only on the printer (STATUS and CONFIG queries), and still fetched only
 * on demand: whether those queries are physically harmless is test T0b, so
 * the admin card never queries on page load — the person presses
 * [Status abfragen]. The wizard's printer step loads it on entry, because the
 * person opened the wizard to look at exactly this.
 *
 * Two layouts: `compact` is the card's one-liner; otherwise every readback
 * line plus the raw CONFIG text (admins only — the server sends `raw_config`
 * to `settings:manage` alone) in its own horizontally scrolling box.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { useAppContext } from "../../context/AppContext";
import type { PrinterStatus } from "../../types/labelPrinter";
import { DOTS_PER_MM, dotsToMmDe, errorText, formatMmDe, sensorKindLabel } from "../../utils/labelCalibration";
import { getPrinterStatus } from "../../utils/labelPrinterApi";
import "../../styles/label-calibration.css";

export interface PrinterStatusPanelProps {
  compact?: boolean;
  autoLoad?: boolean;
  onStatus?: (status: PrinterStatus) => void;
}

/** "97 + 2,5 mm" from the last `^QD` measurement, or null when there is none. */
function measurement(status: PrinterStatus): string | null {
  const config = status.config;
  if (!config || config.measured_length_dots === null || config.measured_gap_dots === null) return null;
  return `${dotsToMmDe(config.measured_length_dots)} + ${dotsToMmDe(config.measured_gap_dots)} mm`;
}

function DetailLines({ status, de }: { status: PrinterStatus; de: boolean }) {
  const config = status.config;
  const value = (v: number | string | null | undefined) => (v === null || v === undefined ? "?" : typeof v === "number" ? formatMmDe(v) : v);
  const measured = measurement(status);
  return (
    <ul className="lc-list lc-status-lines">
      <li>{`Status: ${status.code_text}`}</li>
      {config && (
        <>
          <li>{`Sensor: ${sensorKindLabel(config.sensor_kind, de)}${config.sensor_line ? ` (${config.sensor_line})` : ""}`}</li>
          <li>
            {de
              ? `Am Drucker gespeichert: Breite ${value(config.width_mm)} mm · Etikett/Spalt ${value(config.stored_q)} · Schwärzung ${value(config.darkness)} · Geschwindigkeit ${value(config.speed_ips)} · Stopp ${value(config.stop_mm)} mm`
              : `Stored on the printer: width ${value(config.width_mm)} mm · label/gap ${value(config.stored_q)} · darkness ${value(config.darkness)} · speed ${value(config.speed_ips)} · stop ${value(config.stop_mm)} mm`}
          </li>
          {measured && (
            <li>
              {de
                ? `Letzte Messung: ${measured} (${config.measured_length_dots} + ${config.measured_gap_dots} Punkte)`
                : `Last measurement: ${measured} (${config.measured_length_dots} + ${config.measured_gap_dots} dots)`}
            </li>
          )}
          {config.row_offset_dots !== null && (
            <li>
              {de
                ? `Zeilenversatz: ${config.row_offset_dots} Punkte (${formatMmDe(config.row_offset_dots / DOTS_PER_MM)} mm)`
                : `Row offset: ${config.row_offset_dots} dots (${formatMmDe(config.row_offset_dots / DOTS_PER_MM)} mm)`}
            </li>
          )}
          {config.firmware && <li>{`Firmware: ${config.firmware}`}</li>}
        </>
      )}
    </ul>
  );
}

export function PrinterStatusPanel({ compact = false, autoLoad = false, onStatus }: PrinterStatusPanelProps) {
  const { token, language } = useAppContext();
  const de = language === "de";
  const [status, setStatus] = useState<PrinterStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await getPrinterStatus(token, true);
      setStatus(next);
      onStatus?.(next);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [token, onStatus]);

  // Load once on mount when asked to; every later refresh is a button press.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (autoLoad) void loadRef.current();
  }, [autoLoad]);

  const button = (
    <button type="button" className="werkstatt-card-action lc-btn" onClick={() => void load()} disabled={loading}>
      {loading ? (de ? "Fragt ab …" : "Querying …") : status ? (de ? "Erneut abfragen" : "Query again") : de ? "Status abfragen" : "Query status"}
    </button>
  );

  const measured = status ? measurement(status) : null;
  return (
    <div className="lc-scope lc-status">
      {compact && status && (
        <p className={`lc-status-line${status.ready ? " lc-status-line--ok" : ""}`} role="status">
          {`● ${status.code_text} · Sensor ${sensorKindLabel(status.config?.sensor_kind ?? "unknown", de)}`}
          {measured ? ` · ${de ? "letzte Messung" : "last measurement"} ${measured}` : ""}
        </p>
      )}
      {!compact && status && <DetailLines status={status} de={de} />}
      {status?.warnings.map((warning) => (
        <p key={warning.code} className="lc-warn">
          ⚠ {warning.message}
        </p>
      ))}
      {!compact && status?.raw_config && (
        <details className="lc-details">
          <summary>{de ? "Rohdaten" : "Raw data"}</summary>
          <pre className="lc-mono-box">{status.raw_config}</pre>
        </details>
      )}
      {error !== null && (
        <p className="lc-error" role="alert">
          {errorText(error)}
        </p>
      )}
      <div className="lc-actions">{button}</div>
    </div>
  );
}
