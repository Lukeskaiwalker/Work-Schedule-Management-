/**
 * Step 1 of "Neuer Lagerartikel": the code, from whichever reader is to hand.
 *
 * Three input paths, one field. The desk has a USB wedge (which types the
 * barcode and presses Enter, so it lands in the focused field by itself); the
 * tablet in the workshop has a camera and no wedge; and a label that has been
 * scraped off leaves nothing but the keyboard. The owner asked specifically
 * for the camera path — "we should be able to scan the EAN code from the
 * mobile and tablet version as well so we can do the item scanning later
 * faster" — so it is a first-class button, not a fallback.
 *
 * "Ohne Code weiter" is deliberately as prominent as the rest: plenty of
 * workshop stock has no barcode at all, and a dialog that insists on one would
 * send people back to the spreadsheet.
 */
import { useEffect, useRef, useState } from "react";

import { useBarcodeScanner } from "../../hooks/useBarcodeScanner";
import { CameraScannerSheet, type ScanOutcome } from "./CameraScannerSheet";

export interface ArtikelCodeStepProps {
  de: boolean;
  language: string;
  /** In flight — the lookup is a network call and may reach a webshop. */
  busy: boolean;
  error: string | null;
  /** Resolve the code. The camera sheet shows the label it returns. */
  onSubmit: (code: string) => Promise<ScanOutcome>;
  onSkip: () => void;
  /** Prefilled when the dialog was opened from a scan that already happened. */
  initialCode?: string;
}

export function ArtikelCodeStep({
  de,
  language,
  busy,
  error,
  onSubmit,
  onSkip,
  initialCode = "",
}: ArtikelCodeStepProps) {
  const [code, setCode] = useState(initialCode);
  const [cameraOpen, setCameraOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    // The wedge types into whatever has focus, so the field has to have it.
    inputRef.current?.focus();
  }, []);

  /* The hook suppresses itself while an input is focused, which is exactly
   * what we want for the *typed* case — but a wedge burst into the focused
   * field ends with Enter and is handled by the form's submit instead. This
   * listener catches the other case: a scan while focus sits on a button. */
  useBarcodeScanner({
    enabled: !cameraOpen && !busy,
    onScan: (scanned) => {
      setCode(scanned);
      void onSubmit(scanned);
    },
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = code.trim();
    if (!trimmed || busy) return;
    void onSubmit(trimmed);
  };

  return (
    <div className="stock-code-step">
      <form className="stock-code-form" onSubmit={submit}>
        <label className="werkstatt-field werkstatt-field--grow">
          <span className="werkstatt-field-label">
            {de ? "Code scannen oder eingeben" : "Scan or enter a code"}
          </span>
          <input
            ref={inputRef}
            type="text"
            className="werkstatt-field-input stock-code-input"
            value={code}
            disabled={busy}
            placeholder={de ? "EAN, SP-Nummer oder Lieferanten-Nr." : "EAN, SP number or supplier no."}
            onChange={(event) => setCode(event.target.value)}
          />
        </label>
        <div className="stock-code-actions">
          <button
            type="submit"
            className="werkstatt-action-btn werkstatt-action-btn--primary"
            disabled={busy || !code.trim()}
          >
            {busy ? (de ? "Suche…" : "Searching…") : de ? "Suchen" : "Look up"}
          </button>
          <button
            type="button"
            className="werkstatt-action-btn"
            disabled={busy}
            onClick={() => setCameraOpen(true)}
          >
            {de ? "Kamera" : "Camera"}
          </button>
          <button type="button" className="werkstatt-action-btn" disabled={busy} onClick={onSkip}>
            {de ? "Ohne Code weiter" : "Continue without a code"}
          </button>
        </div>
      </form>

      <p className="stock-code-hint muted">
        {de
          ? "Gefunden wird zuerst im eigenen Bestand, dann im Lieferantenkatalog und zuletzt im Unielektro-Webshop."
          : "We search your own stock first, then the supplier catalogue, and finally the Unielektro webshop."}
      </p>

      {error && (
        <p className="stock-code-error" role="alert">
          {error}
        </p>
      )}

      <CameraScannerSheet
        open={cameraOpen}
        language={language}
        onClose={() => setCameraOpen(false)}
        onScan={async (scanned) => {
          setCode(scanned);
          const outcome = await onSubmit(scanned);
          // A resolved code leaves the sheet: the next step is a decision, and
          // a camera still running over it would keep re-firing on the label
          // lying in frame.
          if (outcome.ok) setCameraOpen(false);
          return outcome;
        }}
      />
    </div>
  );
}
