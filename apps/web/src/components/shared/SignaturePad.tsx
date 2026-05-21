import React, { useEffect, useRef } from "react";
import SignatureCanvas from "react-signature-canvas";

/**
 * Touch- and pointer-friendly signature capture for the Baustellenbericht
 * form. Wraps the well-tested ``react-signature-canvas`` library with a
 * small layer that:
 *
 *   - sizes the canvas to fit its container (full width × 100px tall —
 *     enough for a comfortable scribble on a tablet, not so tall that it
 *     dominates the form on mobile)
 *   - returns a data-URL PNG via the controlled ``onChange`` prop so the
 *     parent form treats the signature like any other form field
 *   - exposes a "Löschen" / "Clear" button so the user can redo without
 *     hunting for a clear gesture
 *   - shows a visible placeholder hint ("Hier unterschreiben") which
 *     disappears as soon as the user starts drawing
 *
 * Storage shape: the parent receives ``value`` as a base64-encoded PNG
 * data URL (``"data:image/png;base64,..."``). When the user clears the
 * pad, ``value`` becomes an empty string. The backend's
 * ``ConstructionReportSignature`` schema accepts both prefixed and raw
 * base64.
 *
 * Why react-signature-canvas: handles pointer events (mouse / touch /
 * pen) and high-DPI retina canvas scaling out of the box. ~7KB
 * gzipped; the alternative would be ~80 LOC of canvas + pointer event
 * plumbing in this file, with subtle edge cases (palm rejection on
 * iPad, sub-pixel rendering on Android) that the library already
 * solved.
 */
export interface SignaturePadProps {
  /** Base64 PNG data URL (or empty string when no signature captured). */
  value: string;
  /** Called with the new data URL whenever the user finishes a stroke or clears. */
  onChange: (dataUrl: string) => void;
  /** Label rendered above the pad (e.g. "Für SMPL Energy"). */
  label: string;
  /** Placeholder hint inside the pad before the user starts drawing. */
  placeholder?: string;
  /** Optional ID hook for tests / accessibility. */
  id?: string;
  /** When true, render with a softer border so the operator notices the
   *  field is required. Customer signature is optional → no warning. */
  required?: boolean;
  /** UI language for the Löschen / Clear button. */
  language?: "de" | "en";
}

export function SignaturePad({
  value,
  onChange,
  label,
  placeholder,
  id,
  required = false,
  language = "de",
}: SignaturePadProps) {
  const padRef = useRef<SignatureCanvas | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // When ``value`` changes externally (e.g. draft restore or programmatic
  // reset), push it back into the canvas. The library doesn't have a
  // controlled-component API, so we manually sync via fromDataURL/clear.
  useEffect(() => {
    const pad = padRef.current;
    if (!pad) return;
    if (!value) {
      pad.clear();
      return;
    }
    // fromDataURL replaces whatever is currently drawn — only call it
    // when the value differs from what the canvas already shows, to
    // avoid flicker during stroke capture.
    const currentDataUrl = pad.isEmpty() ? "" : pad.toDataURL("image/png");
    if (currentDataUrl !== value) {
      pad.fromDataURL(value);
    }
  }, [value]);

  // The canvas needs an explicit pixel size; ResizeObserver keeps it
  // synced when the container changes (e.g. orientation change on tablet
  // or window resize on desktop). Without this the canvas captures
  // gestures in the wrong coordinate space and the stroke appears offset.
  useEffect(() => {
    const container = containerRef.current;
    const pad = padRef.current;
    if (!container || !pad) return;

    function sync() {
      if (!container || !pad) return;
      const canvas = pad.getCanvas();
      const ratio = window.devicePixelRatio || 1;
      const rect = container.getBoundingClientRect();
      canvas.width = rect.width * ratio;
      canvas.height = rect.height * ratio;
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.scale(ratio, ratio);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      // After resize, anything previously drawn is lost — restore from value.
      if (value) {
        pad.fromDataURL(value);
      } else {
        pad.clear();
      }
    }

    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(container);
    return () => ro.disconnect();
    // value intentionally omitted from deps: we only want to resync on
    // size changes, not value changes (those are handled by the other
    // effect). Including value here would cause clear/redraw cycles
    // mid-stroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleEnd() {
    const pad = padRef.current;
    if (!pad) return;
    if (pad.isEmpty()) {
      onChange("");
      return;
    }
    onChange(pad.toDataURL("image/png"));
  }

  function handleClear() {
    const pad = padRef.current;
    if (!pad) return;
    pad.clear();
    onChange("");
  }

  const hint = placeholder ?? (language === "de" ? "Hier unterschreiben" : "Sign here");
  const clearLabel = language === "de" ? "Löschen" : "Clear";

  return (
    <div className="signature-pad" id={id}>
      <div className="signature-pad-header">
        <span className="signature-pad-label">
          {label}
          {required ? <span className="signature-pad-required" aria-hidden="true"> *</span> : null}
        </span>
        <button
          type="button"
          className="signature-pad-clear-btn"
          onClick={handleClear}
          disabled={!value}
        >
          {clearLabel}
        </button>
      </div>
      <div
        ref={containerRef}
        className={`signature-pad-canvas-wrapper${value ? " has-signature" : ""}${required ? " is-required" : ""}`}
        // Inline minimum height so the container has a non-zero size even
        // before CSS loads — otherwise ResizeObserver fires once with 0×0
        // and the canvas comes up unusable.
        style={{ minHeight: 100 }}
      >
        <SignatureCanvas
          ref={padRef}
          penColor="#0b2547"
          onEnd={handleEnd}
          canvasProps={{
            className: "signature-pad-canvas",
            style: { width: "100%", height: "100%", display: "block", touchAction: "none" },
          }}
        />
        {!value ? (
          <div className="signature-pad-placeholder" aria-hidden="true">
            {hint}
          </div>
        ) : null}
      </div>
    </div>
  );
}
