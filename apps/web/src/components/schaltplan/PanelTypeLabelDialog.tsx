/**
 * "Schrank-Etikett drucken" — the panel's type label on the label printer.
 *
 * The layout is the owner's blueprint, rendered server-side on the silver
 * 99 × 44 mm type label (WAGO 210-804): logo, QR code, three lines with the
 * customer, the project number and the Baujahr, and the contact lines. The
 * server resolves all of it from the panel; this sheet shows what will
 * print, lets the user change the one free field — Baujahr, which is the
 * current month unless the panel was built earlier — and fires the print.
 *
 * Printing is refused (button disabled, not just a server 400) while the
 * printer holds a different stock: the wrong label would come out cut to
 * the wrong size, and the electrician would have to reload the 210-804
 * anyway.
 *
 * Same bottom sheet as the BMK labels: the reachable third of a phone held
 * in front of an open board.
 */
import { useCallback, useEffect, useState } from "react";

import { PanelTypeLabelPreview } from "./PanelTypeLabelPreview";
import { useAppContext } from "../../context/AppContext";
import {
  getPanelTypeLabel,
  type PanelTypeLabelInfo,
  type PanelTypeLabelPrintRequest,
} from "../../utils/schaltplanApi";

type Props = {
  open: boolean;
  panelId: number;
  busy: boolean;
  onPrint: (body: PanelTypeLabelPrintRequest) => void;
  onClose: () => void;
};

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; info: PanelTypeLabelInfo };

const LOADING: LoadState = { status: "loading" };

/** `MM.YYYY` with MM 01–12 — what the server accepts as Baujahr. */
const BUILD_MONTH_PATTERN = /^(0[1-9]|1[0-2])\.\d{4}$/;
const MIN_COPIES = 1;
const MAX_COPIES = 10;
const DEFAULT_COPIES = "1";

const TITLE = "Schrank-Etikett drucken";
const SUBTITLE = "Typenschild 99 × 44 mm (WAGO 210-804) auf dem Etikettendrucker";
const LOAD_FAILED = "Etikettendaten konnten nicht geladen werden";
const MONTH_HINT = "Monat und Jahr, z. B. 09.2026";
const MONTH_INVALID = "Bitte als MM.JJJJ eingeben, z. B. 09.2026";
const COPIES_HINT = `${MIN_COPIES} bis ${MAX_COPIES} Etiketten`;

export function isBuildMonth(value: string): boolean {
  return BUILD_MONTH_PATTERN.test(value);
}

/** The copies field as a number, or null when it is not a whole 1..10. */
function copiesOf(text: string): number | null {
  const value = Number(text);
  return Number.isInteger(value) && value >= MIN_COPIES && value <= MAX_COPIES ? value : null;
}

function materialWarning(material: string): string {
  return `Für das Schrank-Etikett muss ein 99 × 44 Etikett (WAGO 210-804) eingelegt sein — aktiv ist „${material}“.`;
}

function loadErrorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : LOAD_FAILED;
}

export function PanelTypeLabelDialog({ open, panelId, busy, onPrint, onClose }: Props) {
  const { token } = useAppContext();
  const [load, setLoad] = useState<LoadState>(LOADING);
  const [buildMonth, setBuildMonth] = useState("");
  const [copies, setCopies] = useState(DEFAULT_COPIES);
  // Bumped by "Erneut versuchen"; the load effect keys on it.
  const [attempt, setAttempt] = useState(0);

  // Fetch on every open: the month rolls over, the printer's stock changes,
  // and a Baujahr left from the last print would quietly print the wrong one.
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setLoad(LOADING);
    getPanelTypeLabel(token, panelId)
      .then((info) => {
        if (cancelled) return;
        setLoad({ status: "ready", info });
        setBuildMonth(info.build_month);
        setCopies(DEFAULT_COPIES);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoad({ status: "error", message: loadErrorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [open, panelId, token, attempt]);

  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  if (!open) return null;

  const info = load.status === "ready" ? load.info : null;
  const monthOk = isBuildMonth(buildMonth);
  const copyCount = copiesOf(copies);
  const canPrint = !busy && info !== null && info.material_ok && monthOk && copyCount !== null;

  const print = () => {
    if (!canPrint || copyCount === null) return;
    onPrint({ build_month: buildMonth, copies: copyCount });
  };

  return (
    <>
      <div className="sp-sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="sp-sheet sp-sheet--labels" role="dialog" aria-modal="true" aria-label={TITLE}>
        <div className="sp-sheet-head">
          <div>
            <h3>{TITLE}</h3>
            <small>{SUBTITLE}</small>
          </div>
          <button type="button" className="sp-sheet-close" onClick={onClose} aria-label="Schließen">
            ×
          </button>
        </div>

        <div className="sp-sheet-body">
          {load.status === "loading" && (
            <p className="sp-label-empty" role="status">
              Etikettendaten werden geladen…
            </p>
          )}

          {load.status === "error" && (
            <div className="sp-field">
              <p className="sp-label-warn" role="alert">
                {load.message}
              </p>
              <button type="button" className="sp-btn" onClick={retry}>
                Erneut versuchen
              </button>
            </div>
          )}

          {info && (
            <>
              <section className="sp-label-preview" aria-label="Vorschau">
                <div className="sp-label-rows-head">
                  <span className="sp-field-label">Vorschau (schematisch)</span>
                  <small className="sp-label-summary">Schrift des Druckers weicht leicht ab</small>
                </div>
                <PanelTypeLabelPreview
                  customer={info.customer}
                  projectNumber={info.project_number}
                  buildMonth={buildMonth}
                  contactLines={info.contact_lines}
                  panelNumber={info.panel_number}
                />
              </section>

              <div className="sp-field-grid">
                <label className="sp-field">
                  <span className="sp-field-label">Baujahr</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    placeholder="MM.JJJJ"
                    value={buildMonth}
                    aria-invalid={!monthOk}
                    onChange={(event) => setBuildMonth(event.target.value)}
                  />
                  <small className={monthOk ? "sp-field-hint" : "sp-field-hint sp-field-hint--error"}>
                    {monthOk ? MONTH_HINT : MONTH_INVALID}
                  </small>
                </label>
                <label className="sp-field">
                  <span className="sp-field-label">Anzahl</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={MIN_COPIES}
                    max={MAX_COPIES}
                    step={1}
                    value={copies}
                    aria-invalid={copyCount === null}
                    onChange={(event) => setCopies(event.target.value)}
                  />
                  <small className={copyCount === null ? "sp-field-hint sp-field-hint--error" : "sp-field-hint"}>
                    {COPIES_HINT}
                  </small>
                </label>
              </div>

              <p className="sp-type-label-note">{`Material: ${info.material}`}</p>
              {!info.material_ok && (
                <p className="sp-label-warn" role="status">
                  {materialWarning(info.material)}
                </p>
              )}
            </>
          )}
        </div>

        <div className="sp-sheet-actions">
          <button type="button" className="sp-btn sp-btn--ghost" onClick={onClose}>
            Schließen
          </button>
          <button type="button" className="sp-btn sp-btn--primary" disabled={!canPrint} onClick={print}>
            {busy ? "Drucke…" : "Drucken"}
          </button>
        </div>
      </div>
    </>
  );
}
