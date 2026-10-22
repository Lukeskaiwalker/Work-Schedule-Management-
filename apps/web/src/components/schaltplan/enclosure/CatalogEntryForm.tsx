/**
 * One cabinet or module of the catalogue, as the Werkstatt edits it
 * (docs/PANEL_ENCLOSURE.md §3.1, §3.5, §9 Slice F, §11).
 *
 * Three parts, top to bottom: "Angaben" (what a data sheet says — code,
 * article number, name, family and size, source, checked or not), "Zubehör"
 * (what always goes on the Materialliste, with a quantity) and the "Aufbau
 * (JSON, für Fortgeschrittene)" (zones, rails, pre-fitted parts; a cabinet's
 * grid). Beside them, on a wide screen, or below, on a phone: the live
 * "Vorschau", drawn by the geometry every board uses.
 *
 * The form only builds the body (`onSubmit`); the admin sends it and passes
 * back the server's refusal (`error`), shown as is. Refusals the server
 * would give anyway are said before sending (catalogEntryDraft). On a code
 * that boards use, the fields §3.5 freezes are locked rather than refused
 * after the fact.
 */
import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from "react";

import { EnclosureFrontSvg } from "./EnclosureFrontSvg";
import { SheetSection } from "./EnclosureSheetFrame";
import { CatalogAccessories } from "./CatalogAccessories";
import { ENCLOSURE_ZOOM_STEPS } from "./enclosureFrontLayout";
import {
  ARTICLE_MAX,
  CODE_MAX,
  FAMILIES,
  FAMILY_LABELS,
  FIELD_HEIGHTS,
  MAX_HEIGHT_UNITS,
  MAX_WIDTH_FIELDS,
  NAME_MAX,
  NOTE_MAX,
  SOURCE_MAX,
  applyTemplate,
  entryFromDraft,
  specFromDraft,
  switchEntryType,
  usedByText,
  type AnySpec,
  type CatalogDraft,
} from "./catalogEntryDraft";
import { previewScene, previewZoomStep, type PreviewResult } from "./catalogEntryPreview";
import type { CatalogEntry, CatalogEntryIn, CatalogEntryType, ModuleFamily } from "../../../types/panelEnclosure";
import "../../../styles/schaltplan-enclosure-admin.css";

export interface CatalogEntryFormProps {
  mode: "create" | "edit";
  /** Where the form starts: an entry's spec (edit), a blank, a template or a shelf article (create). */
  initialDraft: CatalogDraft;
  /** The stored spec an edit replaces — the keys and sizes it binds (§3.5). Null when creating or when it is broken. */
  original: AnySpec | null;
  /** Boards that use the code (all plans); > 0 locks size, family and field height. */
  usedByPlans: number;
  /** Offered under "Vorlage: wie …" when creating; only those of the draft's type are listed. */
  templates: readonly CatalogEntry[];
  busy: boolean;
  /** The server's refusal of the last send, shown as is. */
  error: string | null;
  onSubmit: (body: CatalogEntryIn) => void;
  onCancel: () => void;
  /** Whether the draft differs from where the form started — the admin asks before dropping it. */
  onDirtyChange?: (dirty: boolean) => void;
}

// ── Small fields ─────────────────────────────────────────────────────────────

type FieldProps = { label: string; hint?: string; children: (id: string, describedBy: string | undefined) => ReactNode };

function Field({ label, hint, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="sp-field">
      <label className="sp-field-label" htmlFor={id}>
        {label}
      </label>
      {children(id, hint ? hintId : undefined)}
      {hint ? (
        <span id={hintId} className="sp-field-hint">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

type TextProps = { label: string; value: string; maxLength: number; disabled?: boolean; hint?: string; onChange: (value: string) => void };

function TextField({ label, value, maxLength, disabled, hint, onChange }: TextProps) {
  return (
    <Field label={label} hint={hint}>
      {(id, describedBy) => (
        <input id={id} type="text" value={value} maxLength={maxLength} disabled={disabled} aria-describedby={describedBy} onChange={(event) => onChange(event.target.value)} />
      )}
    </Field>
  );
}

type Option = { value: string; label: string };
type SelectProps = { label: string; value: string; options: readonly Option[]; disabled?: boolean; onChange: (value: string) => void };

function SelectField({ label, value, options, disabled, onChange }: SelectProps) {
  return (
    <Field label={label}>
      {(id) => (
        <select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

const range = (count: number) => Array.from({ length: count }, (_, i) => i + 1);
const WIDTH_OPTIONS: Option[] = range(MAX_WIDTH_FIELDS).map((n) => ({ value: String(n), label: n === 1 ? "1 Feld" : `${n} Felder` }));
const HEIGHT_OPTIONS: Option[] = range(MAX_HEIGHT_UNITS).map((n) => ({ value: String(n), label: `${n} · ${n * 150} mm` }));
const FAMILY_OPTIONS: Option[] = FAMILIES.map((family) => ({ value: family, label: FAMILY_LABELS[family] }));

function fieldHeightOptions(current: number | null): Option[] {
  const heights = current !== null && !FIELD_HEIGHTS.includes(current) ? [...FIELD_HEIGHTS, current] : FIELD_HEIGHTS;
  return [
    ...heights.map((height) => ({ value: String(height), label: `${height} mm (Schrank ${height + 50} mm)` })),
    { value: "", label: "jede Höhe (z. B. Abdeckung)" },
  ];
}

// ── Sections ─────────────────────────────────────────────────────────────────

type Patch = (patch: Partial<CatalogDraft>) => void;

function ModuleSizes({ draft, locked, onPatch }: { draft: CatalogDraft; locked: boolean; onPatch: Patch }) {
  return (
    <div className="sp-field-grid sp-encl-admin-sizes">
      <SelectField label="Familie" value={draft.family} options={FAMILY_OPTIONS} disabled={locked} onChange={(family) => onPatch({ family: family as ModuleFamily })} />
      <SelectField
        label="Feldhöhe"
        value={draft.field_height_mm === null ? "" : String(draft.field_height_mm)}
        options={fieldHeightOptions(draft.field_height_mm)}
        disabled={locked}
        onChange={(value) => onPatch({ field_height_mm: value ? Number(value) : null })}
      />
      <SelectField label="Breite (Felder)" value={String(draft.width_fields)} options={WIDTH_OPTIONS} disabled={locked} onChange={(value) => onPatch({ width_fields: Number(value) })} />
      <SelectField label="Höhe (Raster à 150 mm)" value={String(draft.height_units)} options={HEIGHT_OPTIONS} disabled={locked} onChange={(value) => onPatch({ height_units: Number(value) })} />
    </div>
  );
}

function Details({ draft, mode, locked, busy, onPatch }: { draft: CatalogDraft; mode: "create" | "edit"; locked: boolean; busy: boolean; onPatch: Patch }) {
  const codeHint = mode === "create" ? "Wie die Hager-Artikelnummer — später nicht mehr änderbar." : undefined;
  return (
    <SheetSection title="Angaben">
      <div className="sp-field-grid">
        <TextField label="Code" value={draft.code} maxLength={CODE_MAX} disabled={mode === "edit" || busy} hint={codeHint} onChange={(code) => onPatch({ code })} />
        <TextField label="Artikelnummer" value={draft.article_no} maxLength={ARTICLE_MAX} disabled={busy} onChange={(article_no) => onPatch({ article_no })} />
      </div>
      <TextField label="Bezeichnung" value={draft.name} maxLength={NAME_MAX} disabled={busy} onChange={(name) => onPatch({ name })} />
      {draft.entryType === "module" ? <ModuleSizes draft={draft} locked={locked || busy} onPatch={onPatch} /> : null}
      <TextField label="Quelle (https-Link)" value={draft.source_url} maxLength={SOURCE_MAX} disabled={busy} onChange={(source_url) => onPatch({ source_url })} />
      <label className="sp-check sp-encl-target">
        <input type="checkbox" checked={draft.verified} disabled={busy} onChange={(event) => onPatch({ verified: event.target.checked })} />
        <span className="sp-check-text">geprüft</span>
      </label>
      <Field label="Was ist ungeprüft? (eine Angabe je Zeile)" hint="Pflicht, solange „geprüft“ aus ist. Die erste Zeile erscheint als Hinweis im Plan.">
        {(id, describedBy) => (
          <textarea id={id} rows={Math.min(8, Math.max(3, draft.unverified.split("\n").length + 1))} value={draft.unverified} disabled={busy} aria-describedby={describedBy} onChange={(event) => onPatch({ unverified: event.target.value })} />
        )}
      </Field>
      <Field label="Notiz">
        {(id) => <textarea id={id} rows={2} value={draft.note} maxLength={NOTE_MAX} disabled={busy} onChange={(event) => onPatch({ note: event.target.value })} />}
      </Field>
    </SheetSection>
  );
}

function AufbauField({ draft, problem, busy, onPatch }: { draft: CatalogDraft; problem: string | null; busy: boolean; onPatch: Patch }) {
  const hint =
    problem ??
    (draft.entryType === "module"
      ? "Zonen, Hutschienen und Vorbestückung. Schlüssel bleiben: ausmustern („retired“: true) statt löschen oder umbenennen."
      : "Maße, Felder und Raster des Schranks.");
  return (
    <div className={`sp-field sp-encl-admin-aufbau${problem ? " sp-encl-admin-aufbau--invalid" : ""}`}>
      <Field label="Aufbau (JSON, für Fortgeschrittene)" hint={hint}>
        {(id, describedBy) => (
          <textarea
            id={id}
            className="sp-encl-admin-json"
            rows={16}
            value={draft.aufbau}
            disabled={busy}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-invalid={problem ? true : undefined}
            aria-describedby={describedBy}
            onChange={(event) => onPatch({ aufbau: event.target.value })}
          />
        )}
      </Field>
    </div>
  );
}

const PREVIEW_CAPTION: Readonly<Record<CatalogEntryType, string>> = {
  module: "Allein in einem Schrank seiner Größe, vorbestückt und mit belegten Zählerplätzen.",
  enclosure: "Leer, mit Feldern und Raster.",
};
const FROZEN_HINT: Readonly<Record<CatalogEntryType, string>> = {
  module: "Größe, Familie und Zählerplätze bleiben fest; Lage, Bezeichnungen, Artikelnummern und Zubehör lassen sich korrigieren.",
  enclosure: "Felder und Raster bleiben fest; Maße, Bezeichnungen, Artikelnummer und Zubehör lassen sich korrigieren.",
};

/** Room for the drawing: a bit less than the preview's own 60vh scroll box. */
function previewMaxHeight(): number {
  const viewport = typeof window !== "undefined" && window.innerHeight > 0 ? window.innerHeight : 800;
  return Math.max(240, Math.round(viewport * 0.55));
}

function Preview({ result, entryType }: { result: PreviewResult; entryType: CatalogEntryType }) {
  const [step, setStep] = useState(0);
  return (
    <SheetSection title="Vorschau" className="sp-encl-admin-preview">
      {result.ok ? (
        <EnclosureFrontSvg
          // A new size remounts the drawing, so it fits again (the drawing refits on a new width only).
          key={`${result.scene.width}x${result.scene.height}`}
          scene={result.scene}
          zoom={ENCLOSURE_ZOOM_STEPS[step] ?? ENCLOSURE_ZOOM_STEPS[0]}
          highlightDeviceId={null}
          selectedModuleId={null}
          readOnly
          unitMm={result.unitMm}
          onFitWidth={(px) => setStep(previewZoomStep(result.scene, px, previewMaxHeight()))}
        />
      ) : (
        <p className="sp-encl-hint">{result.reason}</p>
      )}
      <p className="sp-encl-hint">{PREVIEW_CAPTION[entryType]}</p>
    </SheetSection>
  );
}

function TypeSwitch({ value, disabled, onChange }: { value: CatalogEntryType; disabled: boolean; onChange: (type: CatalogEntryType) => void }) {
  const choices: { type: CatalogEntryType; label: string }[] = [
    { type: "module", label: "Modul" },
    { type: "enclosure", label: "Schrank" },
  ];
  return (
    <div className="sp-encl-segmented" role="group" aria-label="Eintragstyp">
      {choices.map((choice) => (
        <button key={choice.type} type="button" className="sp-btn sp-encl-target" aria-pressed={value === choice.type} disabled={disabled} onClick={() => onChange(choice.type)}>
          {choice.label}
        </button>
      ))}
    </div>
  );
}

function TemplatePicker({ templates, value, disabled, onPick }: { templates: readonly CatalogEntry[]; value: string; disabled: boolean; onPick: (code: string) => void }) {
  const options: Option[] = [
    { value: "", label: "— keine —" },
    ...templates.map((entry) => ({ value: entry.code, label: `${entry.code} · ${entry.spec?.name ?? ""}` })),
  ];
  return <SelectField label="Vorlage: wie …" value={value} options={options} disabled={disabled} onChange={onPick} />;
}

// ── Form ─────────────────────────────────────────────────────────────────────

export function CatalogEntryForm(props: CatalogEntryFormProps) {
  const { mode, initialDraft, original, usedByPlans, templates, busy, error, onSubmit, onCancel, onDirtyChange } = props;
  const [draft, setDraft] = useState(initialDraft);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(initialDraft), [draft, initialDraft]);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  const [templateCode, setTemplateCode] = useState("");
  const [checkError, setCheckError] = useState<string | null>(null);
  const merged = useMemo(() => specFromDraft(draft), [draft]);
  const preview = useMemo<PreviewResult>(
    () => (merged.ok ? previewScene(draft.entryType, merged.spec) : { ok: false, reason: "Vorschau nicht möglich: erst den Aufbau (JSON) korrigieren." }),
    [merged, draft.entryType],
  );
  const offered = useMemo(() => templates.filter((entry) => entry.entry_type === draft.entryType && entry.spec && !entry.invalid), [templates, draft.entryType]);

  const patch: Patch = (change) => {
    setDraft((current) => ({ ...current, ...change }));
    setCheckError(null);
  };
  const pickTemplate = (code: string) => {
    const template = offered.find((entry) => entry.code === code);
    setTemplateCode(code);
    if (template) setDraft((current) => applyTemplate(current, template));
  };
  const switchType = (type: CatalogEntryType) => {
    setTemplateCode("");
    setDraft((current) => switchEntryType(current, type));
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const result = entryFromDraft(draft, { original, usedByPlans });
    setCheckError(result.ok ? null : result.error);
    if (result.ok) onSubmit(result.body);
  };

  const locked = mode === "edit" && usedByPlans > 0;
  const shown = checkError ?? error;
  return (
    <form className="sp-encl-admin-form" onSubmit={submit} noValidate>
      <div className="sp-encl-admin-form-main">
        {mode === "create" ? <TypeSwitch value={draft.entryType} disabled={busy} onChange={switchType} /> : null}
        {mode === "create" ? <TemplatePicker templates={offered} value={templateCode} disabled={busy} onPick={pickTemplate} /> : null}
        {mode === "edit" && usedByPlans > 0 ? (
          <div className="sp-encl-admin-used">
            <p className="sp-encl-admin-used-count">{usedByText(usedByPlans)}</p>
            <p className="sp-encl-hint">{FROZEN_HINT[draft.entryType]}</p>
          </div>
        ) : null}
        <Details draft={draft} mode={mode} locked={locked} busy={busy} onPatch={patch} />
        <CatalogAccessories items={draft.accessories} disabled={busy} onChange={(accessories) => patch({ accessories })} />
        <AufbauField draft={draft} problem={merged.ok ? null : merged.error} busy={busy} onPatch={patch} />
      </div>
      <div className="sp-encl-admin-form-side">
        <Preview result={preview} entryType={draft.entryType} />
      </div>
      <div className="sp-encl-admin-form-actions">
        {shown ? (
          <p role="alert" className="sp-encl-admin-message sp-encl-admin-message--error">
            {shown}
          </p>
        ) : null}
        <div className="sp-encl-admin-form-buttons">
          <button type="submit" className="sp-btn sp-btn--primary sp-encl-target" disabled={busy}>
            {busy ? "Speichert…" : mode === "create" ? "Anlegen" : "Speichern"}
          </button>
          <button type="button" className="sp-btn sp-encl-target" disabled={busy} onClick={onCancel}>
            Abbrechen
          </button>
        </div>
      </div>
    </form>
  );
}
