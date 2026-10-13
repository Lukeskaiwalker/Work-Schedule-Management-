/**
 * Profile form "Material bearbeiten" (docs/LABEL_PRINTER_CALIBRATION.md §7.9).
 *
 * Sends one PUT with the configuration revision and only the changed fields
 * (see labelMaterialDraft.ts). It does no range validation of its own: every
 * range error comes back as 422 `invalid_material` with the German message and
 * is shown above the buttons, so the form and the server can never disagree on
 * a limit. On builtins, an overridden field is tagged "angepasst" and has a
 * [Standard] button that puts it on `reset_fields`.
 */
import { useId, useState, type ReactNode } from "react";

import { useAppContext } from "../../context/AppContext";
import type { LabelMaterial, LabelPrinterSettings } from "../../types/labelPrinter";
import { apiErrorCode, errorText, formatMmDe, parseScaleInput, targetText, visibleHints } from "../../utils/labelCalibration";
import { updateLabelMaterial } from "../../utils/labelPrinterApi";
import { buildMaterialUpdate, draftFromMaterial, touchedKeys, type DraftErrors, type MaterialDraft } from "./labelMaterialDraft";
import "../../styles/label-calibration.css";

export interface LabelMaterialFormProps {
  material: LabelMaterial;
  revision: number;
  submitLabel?: string;
  /** The PUT's answer, or null when nothing changed and no request was made. */
  onSaved: (settings: LabelPrinterSettings | null) => void;
  onCancel?: () => void;
  /** 409 stale_revision: reload the settings (the draft is kept). */
  onReload?: () => void;
}

type Choice<T extends string> = Array<[T, string]>;

export function LabelMaterialForm({ material, revision, submitLabel, onSaved, onCancel, onReload }: LabelMaterialFormProps) {
  const { token, language } = useAppContext();
  const de = language === "de";
  const ids = useId();
  const [initial] = useState<MaterialDraft>(() => draftFromMaterial(material));
  const [draft, setDraft] = useState<MaterialDraft>(initial);
  const [reset, setReset] = useState<string[]>([]);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [serverError, setServerError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof MaterialDraft>(key: K, value: MaterialDraft[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }));
  const continuous = draft.length_mm.trim() === "";
  const scale = parseScaleInput(draft.sensor_scale);

  /** "angepasst" + [Standard] for an overridden builtin field; "" = tagged elsewhere (web: on its legend). */
  function overrideTag(field: string): ReactNode {
    if (!field || !material.builtin || !material.overridden_fields.includes(field)) return null;
    if (reset.includes(field)) return <span className="lc-tag">{de ? "wird zurückgesetzt" : "will be reset"}</span>;
    return (
      <>
        <span className="lc-tag">{de ? "angepasst" : "customised"}</span>
        <button type="button" className="lc-link-btn" onClick={() => setReset((r) => [...r, field])}>
          {de ? "Standard" : "Default"}
        </button>
      </>
    );
  }

  function text(key: keyof MaterialDraft, label: string, field: string = key, extra: { inputMode?: "decimal" | "text"; maxLength?: number } = {}) {
    const id = `${ids}-${key}`;
    // The [Standard] button sits next to the <label>, never inside it: a
    // button inside a label becomes the label's control.
    return (
      <div className="lc-field">
        <span>
          <label htmlFor={id}>{label}</label>
          {overrideTag(field)}
        </span>
        <input
          id={id}
          type="text"
          inputMode={extra.inputMode ?? "decimal"}
          maxLength={extra.maxLength}
          value={String(draft[key])}
          onChange={(event) => set(key, event.target.value as never)}
        />
        {errors[key] && <span className="lc-field-error">{errors[key]}</span>}
      </div>
    );
  }

  function radios<T extends string>(key: keyof MaterialDraft, label: string, choices: Choice<T>) {
    return (
      <fieldset className="lc-form-section lc-radio-group">
        <legend>
          {label}
          {overrideTag(key)}
        </legend>
        <div className="lc-radio-row">
          {choices.map(([value, caption]) => (
            <label key={value}>
              <input type="radio" name={`lc-${material.id}-${key}`} checked={draft[key] === value} onChange={() => set(key, value as never)} />
              {caption}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }

  async function submit() {
    const result = buildMaterialUpdate(material, draft, reset, revision, de, touchedKeys(initial, draft));
    setErrors(result.errors);
    setServerError(null);
    if (Object.keys(result.errors).length) return;
    if (!result.changed.length && !reset.length) {
      onSaved(null);
      return;
    }
    setSaving(true);
    try {
      onSaved(await updateLabelMaterial(token, material.id, result.update));
    } catch (err) {
      setServerError(err);
    } finally {
      setSaving(false);
    }
  }

  const limits = material.offset_limits;
  const hints = visibleHints(material);
  return (
    <form className="lc-material-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <fieldset className="lc-form-section">
        <legend>{de ? "Grunddaten" : "Basics"}</legend>
        <div className="lc-form-grid">
          {text("name", "Name", "name", { inputMode: "text", maxLength: 60 })}
          {text("part_no", de ? "Artikelnummer" : "Part number", "part_no", { inputMode: "text", maxLength: 40 })}
          {text("width_mm", de ? "Breite (mm, quer zum Druckkopf)" : "Width (mm, across the head)")}
          {text("length_mm", de ? "Länge (mm, in Vorschubrichtung – leer = Endlos)" : "Length (mm, along the feed – empty = continuous)")}
          {text("gap_mm", de ? "Spalt (mm)" : "Gap (mm)")}
        </div>
      </fieldset>

      {!continuous && (
        <fieldset className="lc-form-section">
          <legend>{de ? "Schwarzmarke" : "Black mark"}</legend>
          <label className="lc-check">
            <input type="checkbox" checked={draft.has_mark} onChange={(event) => set("has_mark", event.target.checked)} />
            <span>{de ? "Material hat Schwarzmarken" : "Media has black marks"}</span>
          </label>
          {draft.has_mark && (
            <div className="lc-form-grid">
              {text("mark_width_mm", de ? "Markenbreite (mm)" : "Mark width (mm)")}
              {text("mark_offset_mm", de ? "Abstand Marke → Etikettenanfang (mm)" : "Mark → label start (mm)")}
              <div className="lc-radio-row">
                <label>
                  <input type="radio" name={`lc-${material.id}-inside`} checked={!draft.mark_inside} onChange={() => set("mark_inside", false)} />
                  {de ? "außerhalb der Marke (+)" : "outside the mark (+)"}
                </label>
                <label>
                  <input type="radio" name={`lc-${material.id}-inside`} checked={draft.mark_inside} onChange={() => set("mark_inside", true)} />
                  {de ? "innerhalb der Marke (−)" : "inside the mark (−)"}
                </label>
              </div>
            </div>
          )}
          {draft.has_mark && draft.sensor_mode === "see_through" && (
            <p className="lc-info">
              ℹ{" "}
              {de
                ? "Schwarzmarken werden üblicherweise mit dem Reflexsensor erkannt; ob der Durchlichtsensor sie erkennt, ist am Drucker nicht geprüft."
                : "Black marks are usually read by the reflective sensor; whether the see-through sensor reads them is not tested at the printer."}
            </p>
          )}
        </fieldset>
      )}

      <fieldset className="lc-form-section">
        <legend>Sensor</legend>
        {radios("sensor_mode", de ? "Sensorart" : "Sensor type", [
          ["see_through", de ? "Durchlicht" : "See-through"],
          ["reflective", de ? "Reflex" : "Reflective"],
          ["auto", de ? "Automatisch (nur Etiketten)" : "Automatic (labels only)"],
          ["none", de ? "Kein Sensor (nur Endlos)" : "No sensor (continuous only)"],
        ])}
        {draft.sensor_mode === "none" && (
          <p className="lc-info">
            ℹ{" "}
            {de
              ? "Drucker erkennt dann vermutlich auch das Materialende nicht (nicht am Drucker geprüft)."
              : "The printer then probably misses the end of the media too (not tested at the printer)."}
          </p>
        )}
        {text("sensor_scale", de ? "Sensorposition (Skala 1–5, eine Nachkommastelle)" : "Sensor position (scale 1–5, one decimal)")}
        <p className="lc-small">{de ? "3 = Mitte der Materialbahn, 1 Teilstrich = 1 mm" : "3 = centre of the media path, 1 tick = 1 mm"}</p>
        {scale !== null && <p className="lc-info">{targetText(scale, de)}</p>}
      </fieldset>

      <fieldset className="lc-form-section">
        <legend>{de ? "Einlegen" : "Loading"}</legend>
        {radios("guide", de ? "Materialführung" : "Media guides", [
          ["max", de ? "ganz offen" : "fully open"],
          ["fit", de ? "1 mm + Breite + 1 mm" : "1 mm + width + 1 mm"],
        ])}
        {radios("feed_path", de ? "Zuführung" : "Feed", [
          ["internal", de ? "interner Rollenhalter" : "internal roll holder"],
          ["external", de ? "externer Abroller" : "external unwinder"],
        ])}
        {radios("roller", de ? "Andruckwalze" : "Platen roller", [
          ["258-5006", de ? "258-5006 (schwarz, glatt)" : "258-5006 (black, smooth)"],
          ["258-5007", de ? "258-5007 (dunkelgrün, gerillt – nur WMB-Inline)" : "258-5007 (dark green, grooved – WMB-Inline only)"],
        ])}
      </fieldset>

      <fieldset className="lc-form-section">
        <legend>
          {de ? "Material auf der Rolle" : "Media on the roll"}
          {overrideTag("web")}
        </legend>
        <div className="lc-form-grid">
          {text("lanes", de ? "Bahnen nebeneinander" : "Lanes side by side", "")}
          {text("label_across_mm", de ? "Etikett quer (mm)" : "Label across (mm)", "")}
          {text("label_along_mm", de ? "Etikett längs (mm)" : "Label along (mm)", "")}
          {text("lane_gap_mm", de ? "Abstand zwischen den Bahnen (mm)" : "Gap between lanes (mm)", "")}
          {text("liner_width_mm", de ? "Trägerbreite (mm)" : "Liner width (mm)", "")}
        </div>
        <label className="lc-check">
          <input type="checkbox" checked={draft.web_measured} onChange={(event) => set("web_measured", event.target.checked)} />
          <span>{de ? "Maße am Material nachgemessen" : "Sizes measured on the media"}</span>
        </label>
      </fieldset>

      <fieldset className="lc-form-section">
        <legend>{de ? "Druck" : "Printing"}</legend>
        <div className="lc-form-grid">
          {text("darkness", de ? "Schwärzung (0–19, leer = Grundeinstellung)" : "Darkness (0–19, empty = baseline)")}
          {text("speed_ips", de ? "Geschwindigkeit (2–4, leer = Grundeinstellung)" : "Speed (2–4, empty = baseline)")}
          {text("stop_mm", de ? "Stopp-Position (mm, leer = Grundeinstellung)" : "Stop position (mm, empty = baseline)")}
        </div>
      </fieldset>

      <fieldset className="lc-form-section">
        <legend>{de ? "Versatz" : "Offsets"}</legend>
        <div className="lc-form-grid">
          {text("x_offset_mm", de ? `Versatz Vorschub (mm, ${formatMmDe(limits.x_min)} bis ${formatMmDe(limits.x_max)})` : `Feed offset (mm, ${formatMmDe(limits.x_min)} to ${formatMmDe(limits.x_max)})`)}
          {text("across_offset_mm", de ? `Versatz quer (mm, ${formatMmDe(limits.across_min)} bis ${formatMmDe(limits.across_max)})` : `Across offset (mm, ${formatMmDe(limits.across_min)} to ${formatMmDe(limits.across_max)})`)}
        </div>
      </fieldset>

      {hints.length > 0 && (
        <ul className="lc-list lc-info">
          {hints.map((hint) => (
            <li key={`${hint.topic}-${hint.text}`}>ℹ {hint.text}</li>
          ))}
        </ul>
      )}

      {serverError !== null && (
        <div className="lc-error" role="alert">
          <p className="lc-intro">{errorText(serverError)}</p>
          {apiErrorCode(serverError) === "stale_revision" && onReload && (
            <button type="button" className="werkstatt-action-btn lc-btn" onClick={onReload}>
              {de ? "Neu laden" : "Reload"}
            </button>
          )}
        </div>
      )}
      <div className="lc-actions">
        <button type="submit" className="werkstatt-action-btn werkstatt-action-btn--primary lc-btn" disabled={saving}>
          {saving ? (de ? "Speichert …" : "Saving …") : submitLabel ?? (de ? "Speichern" : "Save")}
        </button>
        {onCancel && (
          <button type="button" className="werkstatt-action-btn lc-btn" onClick={onCancel}>
            {de ? "Abbrechen" : "Cancel"}
          </button>
        )}
      </div>
    </form>
  );
}
