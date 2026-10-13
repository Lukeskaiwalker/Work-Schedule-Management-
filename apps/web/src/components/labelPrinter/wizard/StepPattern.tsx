/**
 * Wizard step 5 "Messmuster" (docs/LABEL_PRINTER_CALIBRATION.md §4.11, §7.6).
 *
 * The pattern prints with the profile's CURRENT offsets, so what the operator
 * measures is the remaining error; corrections are computed against the
 * offsets the server reports for that print (not the profile after a save, or
 * a second [Übernehmen] would correct twice). Values are clamped to the
 * material's offset limits before they are shown or PUT, so the server never
 * rejects a computed correction.
 *
 * Multi-lane stock (210-805) has no pattern in this build: its physical roll
 * is not its print geometry, and a box would cross real gaps (test T8).
 */
import { useState } from "react";

import { useAppContext } from "../../../context/AppContext";
import type { LabelMaterial, LabelMaterialUpdate, LabelPrinterSettings, PatternResult } from "../../../types/labelPrinter";
import { apiErrorCode, errorText, formatFixedDe, formatMmDe, offsetCorrections, parseDecimalInput } from "../../../utils/labelCalibration";
import { updateLabelMaterial } from "../../../utils/labelPrinterApi";
import { ConfirmFeedDialog } from "../ConfirmFeedDialog";
import { LabelPatternPreview } from "../LabelPatternPreview";
import type { CalibrationSessionApi } from "../useCalibrationSession";

export interface PatternInputs {
  lead: string;
  trail: string;
  left: string;
  right: string;
  ruler: string;
}

export const EMPTY_PATTERN_INPUTS: PatternInputs = { lead: "", trail: "", left: "", right: "", ruler: "" };

/** A typed measurement: null when empty, NaN when outside 0…max or not a number. */
export function measured(text: string, max: number): number | null {
  if (text.trim() === "") return null;
  const value = parseDecimalInput(text);
  return value === null || value < 0 || value > max ? Number.NaN : value;
}

export interface StepPatternProps {
  material: LabelMaterial;
  calibration: CalibrationSessionApi;
  revision: number;
  pattern: PatternResult | null;
  onPattern: (pattern: PatternResult) => void;
  inputs: PatternInputs;
  onInputs: (inputs: PatternInputs) => void;
  onSettings: (settings: LabelPrinterSettings) => void;
  onPutError: (err: unknown) => void;
  onSavedOffsets: (x: number | null, across: number | null) => void;
  onSkip: () => void;
}

export function StepPattern(props: StepPatternProps) {
  const { material, calibration, revision, pattern, inputs } = props;
  const { token, language } = useAppContext();
  const de = language === "de";
  const [dialog, setDialog] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  if (!material.pattern_supported) {
    return (
      <div className="lc-step-pattern">
        <p className="lc-info">{de ? "Messmuster für mehrbahniges Material folgt nach dem Praxistest (T8)." : "Measuring pattern for multi-lane media follows the field test (T8)."}</p>
        <div className="lc-actions">
          <button type="button" className="werkstatt-action-btn lc-btn" onClick={props.onSkip}>
            {de ? "Überspringen" : "Skip"}
          </button>
        </div>
      </div>
    );
  }

  const geometry = pattern?.geometry ?? null;
  const values = {
    lead: measured(inputs.lead, 30),
    trail: measured(inputs.trail, 30),
    left: measured(inputs.left, 30),
    right: measured(inputs.right, 30),
    ruler: measured(inputs.ruler, 800),
  };
  const invalid = Object.values(values).some((v) => v !== null && Number.isNaN(v));
  const clean = (v: number | null) => (v === null || Number.isNaN(v) ? null : v);
  const result =
    geometry && pattern
      ? offsetCorrections(
          { x_offset_mm: pattern.x_offset_mm, across_offset_mm: pattern.across_offset_mm, offset_limits: material.offset_limits },
          geometry,
          { lead: clean(values.lead), trail: clean(values.trail), left: clean(values.left), right: clean(values.right), rulerMeasured: clean(values.ruler) },
          de,
        )
      : null;
  const changes = [result?.xOffset, result?.across].filter((c) => c && c.to !== c.from);
  const biggest = Math.max(0, ...changes.map((c) => Math.abs(c!.to - c!.from)));

  async function print() {
    setDialog(false);
    setError(null);
    try {
      props.onPattern(await calibration.printPattern());
      props.onInputs(EMPTY_PATTERN_INPUTS);
      setSaved([]);
    } catch (err) {
      setError(err);
    }
  }

  async function adopt(reprint: boolean) {
    if (invalid || !result) return;
    const body: LabelMaterialUpdate = { revision };
    if (result.xOffset && result.xOffset.to !== result.xOffset.from) body.x_offset_mm = result.xOffset.to;
    if (result.across && result.across.to !== result.across.from) body.across_offset_mm = result.across.to;
    setError(null);
    if (body.x_offset_mm !== undefined || body.across_offset_mm !== undefined) {
      setSaving(true);
      try {
        props.onSettings(await updateLabelMaterial(token, material.id, body));
      } catch (err) {
        // A stale revision is shown once, by the wizard, with its [Neu laden].
        setError(apiErrorCode(err) === "stale_revision" ? null : err);
        props.onPutError(err);
        return;
      } finally {
        setSaving(false);
      }
      const lines: string[] = [];
      if (body.x_offset_mm !== undefined) lines.push(de ? `Gespeichert: Versatz Vorschub ${formatMmDe(body.x_offset_mm)} mm` : `Saved: feed offset ${formatMmDe(body.x_offset_mm)} mm`);
      if (body.across_offset_mm !== undefined) lines.push(de ? `Gespeichert: Versatz quer ${formatMmDe(body.across_offset_mm)} mm` : `Saved: across offset ${formatMmDe(body.across_offset_mm)} mm`);
      setSaved(lines);
      props.onSavedOffsets(body.x_offset_mm ?? null, body.across_offset_mm ?? null);
    }
    if (reprint) setDialog(true);
  }

  const field = (key: keyof PatternInputs, label: string, max: number) => (
    <label className="lc-field" key={key}>
      <span>{label}</span>
      <input type="text" inputMode="decimal" value={inputs[key]} onChange={(e) => props.onInputs({ ...inputs, [key]: e.target.value })} />
      {values[key] !== null && Number.isNaN(values[key]) && (
        <span className="lc-field-error">
          {de ? `Bitte einen Wert zwischen 0 und ${max} mm eingeben` : `Please enter a value between 0 and ${max} mm`}
        </span>
      )}
    </label>
  );

  const diecut = geometry?.kind === "diecut";
  return (
    <div className="lc-step-pattern">
      <p className="lc-intro">
        {de
          ? "Das Messmuster zeigt, wo SMPL druckt. Miss die Abstände mit dem Messschieber – SMPL rechnet die Korrektur aus."
          : "The measuring pattern shows where SMPL prints. Measure the distances with a caliper – SMPL computes the correction."}
      </p>
      <div className="lc-actions">
        <button type="button" className="werkstatt-action-btn werkstatt-action-btn--primary lc-btn" onClick={() => setDialog(true)} disabled={calibration.busy === "pattern"}>
          {de ? "Messmuster drucken" : "Print measuring pattern"}
        </button>
      </div>

      {geometry && (
        <>
          <LabelPatternPreview geometry={geometry} offsets={{ lead: clean(values.lead), trail: clean(values.trail), left: clean(values.left), right: clean(values.right) }} de={de} />
          <div className="lc-form-grid">
            {diecut && field("lead", de ? "Rand vorne (A)" : "Front margin (A)", 30)}
            {diecut && field("trail", de ? "Rand hinten (B, optional)" : "Rear margin (B, optional)", 30)}
            {field("left", de ? "Rand links (L)" : "Left margin (L)", 30)}
            {field("right", de ? "Rand rechts (R, optional)" : "Right margin (R, optional)", 30)}
            {diecut && geometry.ruler_to_mm !== null &&
              field("ruler", de ? `Lineal 10 → ${geometry.ruler_to_mm} gemessen (optional)` : `Ruler 10 → ${geometry.ruler_to_mm} measured (optional)`, 800)}
          </div>
          {result?.xOffset && (
            <p className="lc-target-line">
              {de ? "Versatz Vorschub" : "Feed offset"}: {formatFixedDe(result.xOffset.from)} → {formatFixedDe(result.xOffset.to)} mm
            </p>
          )}
          {result?.across && (
            <p className="lc-target-line">
              {de ? "Versatz quer" : "Across offset"}: {formatFixedDe(result.across.from)} → {formatFixedDe(result.across.to)} mm
            </p>
          )}
          {result?.infos.map((info) => (
            <p key={info} className="lc-info">
              ℹ {info}
            </p>
          ))}
          <div className="lc-actions">
            {biggest > 0.3 && (
              <button type="button" className="werkstatt-action-btn werkstatt-action-btn--primary lc-btn" disabled={saving || invalid} onClick={() => void adopt(true)}>
                {de ? "Übernehmen und neu drucken" : "Apply and reprint"}
              </button>
            )}
            <button type="button" className="werkstatt-action-btn lc-btn" disabled={saving || invalid} onClick={() => void adopt(false)}>
              {de ? "Übernehmen" : "Apply"}
            </button>
          </div>
          {saved.map((line) => (
            <p key={line} className="lc-ok">
              {line}
            </p>
          ))}
        </>
      )}
      <div className="lc-actions">
        <button type="button" className="lc-link-btn" onClick={props.onSkip}>
          {de ? "Überspringen" : "Skip"}
        </button>
      </div>
      {error !== null && (
        <p className="lc-error" role="alert">
          {errorText(error)}
        </p>
      )}
      {dialog && <ConfirmFeedDialog variant="pattern" material={material} onConfirm={() => void print()} onCancel={() => setDialog(false)} de={de} />}
    </div>
  );
}
