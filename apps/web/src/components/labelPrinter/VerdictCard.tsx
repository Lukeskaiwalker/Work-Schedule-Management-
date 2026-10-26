/**
 * The result of a calibration run (docs/LABEL_PRINTER_CALIBRATION.md §4.7, §7.5).
 *
 * Title, detail and notes are built by the server and shown verbatim; the
 * card adds the comparison table, the sensor line and how fresh the
 * measurement is. Status is never colour alone — every verdict has its icon
 * AND its title text. The buttons are exactly the server's `offers`, so the UI
 * cannot offer a step the server would refuse (or hide one it allows).
 */
import type { CalibrationVerdict, LabelMaterial, Offer, Verdict } from "../../types/labelPrinter";
import { formatMmDe, formatSignedMmDe, sensorKindLabel } from "../../utils/labelCalibration";
import "../../styles/label-calibration.css";

export interface VerdictCardProps {
  verdict: CalibrationVerdict;
  materials: LabelMaterial[];
  /** "full": the record is saved at the end of the wizard, so save becomes [Weiter]. */
  mode: "quick" | "full";
  busy?: boolean;
  onOffer: (offer: Offer, materialId?: string) => void;
  de?: boolean;
}

const ICON: Record<Verdict, { icon: string; tone: "ok" | "warn" | "bad" | "info" }> = {
  match: { icon: "✓", tone: "ok" },
  mismatch: { icon: "⚠", tone: "warn" },
  other_material: { icon: "⚠", tone: "warn" },
  gap_on_continuous: { icon: "⚠", tone: "warn" },
  no_gap: { icon: "✗", tone: "bad" },
  printer_error: { icon: "✗", tone: "bad" },
  no_result: { icon: "ℹ", tone: "info" },
  unchecked: { icon: "ℹ", tone: "info" },
};

const mm = (value: number | null) => (value === null ? "–" : formatMmDe(value));

function Row({ label, expected, measured, delta }: { label: string; expected: number | null; measured: number | null; delta: number | null }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{mm(expected)}</td>
      <td>{mm(measured)}</td>
      <td>{delta === null ? "–" : formatSignedMmDe(delta)}</td>
    </tr>
  );
}

function freshnessText(verdict: CalibrationVerdict, de: boolean): string {
  if (verdict.freshness === "busy_seen") {
    return de ? "Messung beobachtet (Drucker meldete „misst“)" : "Measurement observed (printer reported \"measuring\")";
  }
  if (verdict.freshness === "none") return de ? "Kein Nachweis einer neuen Messung" : "No proof of a new measurement";
  return de ? "Neues Messergebnis vom Drucker" : "New result from the printer";
}

function sensorText(verdict: CalibrationVerdict, de: boolean): string {
  const kind = sensorKindLabel(verdict.sensor_kind, de);
  if (verdict.sensor_ok === true) return `Sensor: ${kind} ✓`;
  if (verdict.sensor_ok === false && verdict.sensor_expected) {
    return `Sensor: ${kind} – ${de ? "erwartet" : "expected"} ${sensorKindLabel(verdict.sensor_expected, de)} ⚠`;
  }
  return `Sensor: ${kind}`;
}

export function VerdictCard({ verdict, materials, mode, busy = false, onOffer, de = true }: VerdictCardProps) {
  const { icon, tone } = ICON[verdict.verdict];
  const material = materials.find((m) => m.id === verdict.material_id);
  const continuous = material?.continuous ?? verdict.expected_length_mm === null;
  const hasMeasurement = [verdict.measured_length_mm, verdict.measured_gap_mm, verdict.measured_pitch_mm].some((v) => v !== null);
  const gapDelta =
    verdict.measured_gap_mm !== null && verdict.expected_gap_mm !== null
      ? verdict.measured_gap_mm - verdict.expected_gap_mm
      : null;
  const full = mode === "full";

  const buttons = verdict.offers.flatMap((offer) => {
    const primary = "werkstatt-action-btn werkstatt-action-btn--primary lc-btn";
    const secondary = "werkstatt-action-btn lc-btn";
    switch (offer) {
      case "save":
        return [{ key: offer, cls: primary, text: full ? (de ? "Weiter" : "Next") : de ? "Speichern" : "Save", run: () => onOffer(offer) }];
      case "accept_anyway":
        return [{ key: offer, cls: secondary, text: full ? (de ? "Trotzdem fortfahren" : "Continue anyway") : de ? "Trotzdem speichern" : "Save anyway", run: () => onOffer(offer) }];
      case "switch_material":
        return verdict.suggested_material_ids.map((id) => {
          const name = materials.find((m) => m.id === id)?.name ?? id;
          return { key: `${offer}-${id}`, cls: primary, text: de ? `Auf „${name}“ umstellen` : `Switch to "${name}"`, run: () => onOffer(offer, id) };
        });
      case "resense":
        return [{ key: offer, cls: secondary, text: de ? "Sensor prüfen und erneut einmessen" : "Check the sensor and sense again", run: () => onOffer(offer) }];
      case "requery":
        return [{ key: offer, cls: secondary, text: de ? "Ergebnis erneut abfragen" : "Query the result again", run: () => onOffer(offer) }];
      case "reapply":
        return [{ key: offer, cls: secondary, text: de ? "Sensor erneut übertragen" : "Send the sensor again", run: () => onOffer(offer) }];
      default:
        return [];
    }
  });

  return (
    <section className={`lc-verdict lc-verdict--${tone}`} role="status" aria-live="polite">
      <h3 className="lc-verdict-title">
        <span className="lc-verdict-icon" aria-hidden="true">{icon}</span>
        {verdict.title}
      </h3>
      {verdict.detail && <p className="lc-intro">{verdict.detail}</p>}
      {verdict.notes.map((note) => (
        <p key={note} className="lc-small">
          {note}
        </p>
      ))}
      {hasMeasurement && (
        <div className="lc-table-wrap">
          <table className="lc-table">
            <thead>
              <tr>
                <th scope="col">
                  <span className="lc-sr">{de ? "Größe in mm" : "Quantity in mm"}</span>
                </th>
                <th scope="col">{de ? "Profil" : "Profile"}</th>
                <th scope="col">{de ? "Gemessen" : "Measured"}</th>
                <th scope="col">{de ? "Abweichung" : "Deviation"}</th>
              </tr>
            </thead>
            <tbody>
              {!continuous && <Row label={de ? "Etikett" : "Label"} expected={verdict.expected_length_mm} measured={verdict.measured_length_mm} delta={verdict.delta_length_mm} />}
              <Row label={de ? "Spalt" : "Gap"} expected={verdict.expected_gap_mm} measured={verdict.measured_gap_mm} delta={gapDelta} />
              {!continuous && <Row label={de ? "Teilung" : "Pitch"} expected={verdict.expected_pitch_mm} measured={verdict.measured_pitch_mm} delta={verdict.delta_pitch_mm} />}
            </tbody>
          </table>
          <p className="lc-small">
            {verdict.tolerance_mm !== null && `${de ? "Toleranz" : "Tolerance"} ± ${formatMmDe(verdict.tolerance_mm)} mm · `}
            {de
              ? `gerechnet mit ${formatMmDe(verdict.dots_per_mm)} Punkten je mm`
              : `calculated with ${formatMmDe(verdict.dots_per_mm)} dots per mm`}
          </p>
        </div>
      )}
      <p className="lc-small">{sensorText(verdict, de)}</p>
      <p className="lc-small">{freshnessText(verdict, de)}</p>
      {verdict.warnings.map((warning) => (
        <p key={warning.code} className="lc-warn">
          ⚠ {warning.message}
        </p>
      ))}
      <div className="lc-actions">
        {buttons.map((button) => (
          <button key={button.key} type="button" className={button.cls} onClick={button.run} disabled={busy}>
            {button.text}
          </button>
        ))}
      </div>
    </section>
  );
}
