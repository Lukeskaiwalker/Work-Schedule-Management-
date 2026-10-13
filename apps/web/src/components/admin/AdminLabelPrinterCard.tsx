/**
 * AdminLabelPrinterCard — Werkstatt label printer setup in the admin settings.
 *
 * Self-contained on purpose (own fetches, own state) rather than following the
 * weather/OpenAI pattern of App.tsx-owned state: App.tsx is a 9k-line file
 * under active parallel work, and this card has no reason to couple to it.
 *
 * Four concerns live here, in the order an admin meets them:
 *   1. the printer's address (runtime-first, env fallback — `source` says
 *      which is in effect), its status on demand, and the staff switch that
 *      keeps the quick flow admin-only until the physical tests have results,
 *   2. the MATERIAL that is physically loaded: the printer can sense label
 *      gaps but not identity, so this selection is the software's only truth.
 *      Each row opens the quick flow, the full wizard or the profile form
 *      (docs/LABEL_PRINTER_CALIBRATION.md §7.10),
 *   3. custom materials, one inline form away,
 *   4. utilities: Testdruck (adapts to the active material's tier) and free
 *      text for continuous stock (marking strips, shrink tube).
 *
 * Every write carries the configuration revision; the radio only selects the
 * material in SMPL and never sends anything to the printer (critique M2) — it
 * offers the quick flow instead.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { useAppContext } from "../../context/AppContext";
import { CalibrationChip } from "../labelPrinter/CalibrationChip";
import { CalibrationWizard } from "../labelPrinter/CalibrationWizard";
import { LabelMaterialForm } from "../labelPrinter/LabelMaterialForm";
import { MaterialChangeSheet } from "../labelPrinter/MaterialChangeSheet";
import { PrinterStatusPanel } from "../labelPrinter/PrinterStatusPanel";
import type {
  LabelMaterial,
  LabelPrinterSettings,
  LabelPrinterSettingsPatch,
} from "../../types/labelPrinter";
import {
  apiErrorCode,
  dimensionLabel,
  formatLocalTime,
  formatScaleDe,
} from "../../utils/labelCalibration";
import {
  getLabelPrinterSettings,
  patchLabelPrinterSettings,
  printFreetext as postFreetext,
  printTestLabel,
  updatePrinterSettings,
} from "../../utils/labelPrinterApi";
import "../../styles/label-calibration.css";

// The types moved to types/labelPrinter.ts; existing importers keep working.
export type { LabelMaterial, LabelPrinterSettings } from "../../types/labelPrinter";

const TIER_LABELS: Record<string, { de: string; en: string }> = {
  voll: { de: "Voll (Logo + Code)", en: "Full (logo + code)" },
  kompakt: { de: "Kompakt (Code + Nr.)", en: "Compact (code + no.)" },
  mini: { de: "Mini (nur Nummer)", en: "Mini (number only)" },
};

/** "Walze 258-5006 · Rollenhalter innen · Sensor auf 3,4 der Skala" */
function loadingLine(material: LabelMaterial, de: boolean): string {
  const feed = material.feed_path === "external" ? (de ? "Abroller extern" : "external unwinder") : de ? "Rollenhalter innen" : "internal holder";
  return de
    ? `Walze ${material.roller} · ${feed} · Sensor auf ${formatScaleDe(material.sensor_scale)} der Skala`
    : `Roller ${material.roller} · ${feed} · sensor at ${formatScaleDe(material.sensor_scale)} on the scale`;
}

/** `undefined` = closed; `null` = open without a preselected material. */
type QuickTarget = string | null | undefined;

export function AdminLabelPrinterCard() {
  const { token, language } = useAppContext();
  const de = language === "de";

  const [settings, setSettings] = useState<LabelPrinterSettings | null>(null);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("9100");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [rollChanged, setRollChanged] = useState(false);

  const [quickFor, setQuickFor] = useState<QuickTarget>(undefined);
  const [wizardFor, setWizardFor] = useState<string | null>(null);
  const [editFor, setEditFor] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPartNo, setNewPartNo] = useState("");
  const [newWidth, setNewWidth] = useState("");
  const [newLength, setNewLength] = useState("");
  const [newGap, setNewGap] = useState("3");

  const [freetext, setFreetext] = useState("");
  const [freetextCopies, setFreetextCopies] = useState("1");
  const [freetextBusy, setFreetextBusy] = useState(false);

  const adopt = useCallback((current: LabelPrinterSettings) => {
    setSettings(current);
    setHost(current.host);
    setPort(String(current.port));
  }, []);

  const load = useCallback(async () => {
    try {
      adopt(await getLabelPrinterSettings(token));
    } catch {
      // The card degrades to an empty form; saving will surface real errors.
      setSettings(null);
    }
  }, [token, adopt]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Every list/selection mutation goes through one PATCH with the revision. */
  const patch = useCallback(
    async (body: LabelPrinterSettingsPatch, successText: (saved: LabelPrinterSettings) => string) => {
      setSaving(true);
      setFeedback(null);
      try {
        const saved = await patchLabelPrinterSettings(token, { ...body, revision: settings?.revision ?? null });
        adopt(saved);
        setFeedback({ ok: true, text: successText(saved) });
        return saved;
      } catch (err: unknown) {
        setFeedback({ ok: false, text: err instanceof Error ? err.message : String(err) });
        // Someone else saved meanwhile: show their state, the admin repeats the change.
        if (apiErrorCode(err) === "stale_revision") void load();
        return null;
      } finally {
        setSaving(false);
      }
    },
    [token, settings?.revision, adopt, load],
  );

  async function saveAddress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await patch({ host: host.trim(), port: Number.parseInt(port, 10) || 9100 }, (saved) =>
      saved.configured
        ? de
          ? `Gespeichert — Drucker ${saved.host}:${saved.port}`
          : `Saved — printer ${saved.host}:${saved.port}`
        : de
          ? "Gespeichert — Etikettendruck deaktiviert"
          : "Saved — label printing disabled",
    );
  }

  async function selectMaterial(material: LabelMaterial) {
    const saved = await patch({ active_material_id: material.id }, () =>
      de ? `Gewähltes Material: ${material.name}` : `Selected material: ${material.name}`,
    );
    setRollChanged(!!saved);
  }

  async function toggleStaff(enabled: boolean) {
    if (!settings) return;
    setSaving(true);
    setFeedback(null);
    try {
      adopt(await updatePrinterSettings(token, { revision: settings.revision, label_calibration_staff_enabled: enabled }));
    } catch (err: unknown) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message : String(err) });
      if (apiErrorCode(err) === "stale_revision") void load();
    } finally {
      setSaving(false);
    }
  }

  async function addMaterial(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings) return;
    const width = Number.parseFloat(newWidth.replace(",", "."));
    const length = newLength.trim() ? Number.parseFloat(newLength.replace(",", ".")) : null;
    const slug = `custom-${Date.now().toString(36)}`;
    // Echoing the GET objects back is safe: the server ignores derived fields
    // and merges the rest, so an unchanged echo changes nothing but the revision.
    const materials: Partial<LabelMaterial>[] = [
      ...settings.materials.map((m) => ({ ...m })),
      {
        id: slug,
        name: newName.trim(),
        part_no: newPartNo.trim(),
        width_mm: width,
        length_mm: length,
        gap_mm: Number.parseFloat(newGap.replace(",", ".")) || 3,
        x_offset_mm: 2,
        darkness: null,
      },
    ];
    const saved = await patch({ materials }, () =>
      de ? `Material „${newName.trim()}“ angelegt` : `Material "${newName.trim()}" added`,
    );
    if (saved) {
      setAddOpen(false);
      setNewName("");
      setNewPartNo("");
      setNewWidth("");
      setNewLength("");
      setNewGap("3");
    }
  }

  async function removeMaterial(material: LabelMaterial) {
    if (!settings) return;
    const materials = settings.materials.filter((m) => m.id !== material.id).map((m) => ({ ...m }));
    await patch(
      {
        materials,
        // Deleting the active profile falls back to the default stock.
        active_material_id:
          settings.active_material_id === material.id ? "wago-210-804" : settings.active_material_id,
      },
      () => (de ? `Material „${material.name}“ entfernt` : `Material "${material.name}" removed`),
    );
  }

  async function testPrint() {
    setTesting(true);
    setFeedback(null);
    try {
      const result = await printTestLabel(token);
      setFeedback({ ok: result.ok, text: result.detail });
    } catch (err: unknown) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  }

  async function printFreetext(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFreetextBusy(true);
    setFeedback(null);
    try {
      const result = await postFreetext(token, freetext.trim(), Number.parseInt(freetextCopies, 10) || 1);
      setFeedback({ ok: result.ok, text: result.detail });
      if (result.ok) setFreetext("");
    } catch (err: unknown) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setFreetextBusy(false);
    }
  }

  const sourceLabel =
    settings?.source === "runtime"
      ? de
        ? "über Admin-Einstellungen"
        : "via admin settings"
      : settings?.source === "env"
        ? de
          ? "über Server-Umgebung"
          : "via server environment"
        : null;

  const activeMaterial = settings?.materials.find((m) => m.id === settings.active_material_id);
  const editing = settings?.materials.find((m) => m.id === editFor) ?? null;
  const running = settings?.session ?? null;

  return (
    <div className="admin-page-card admin-settings-block lc-scope">
      <h2 className="admin-page-card-title">
        {de ? "Etikettendrucker (Werkstatt)" : "Label printer (workshop)"}
      </h2>
      <p className="admin-tools-desc">
        {de
          ? "WAGO Smart Printer für Maschinen-Etiketten. IP-Adresse im lokalen Netz eintragen — leer lassen, um den Etikettendruck zu deaktivieren."
          : "WAGO Smart Printer for machine labels. Enter its LAN IP address — leave empty to disable label printing."}
      </p>
      <form className="admin-settings-form" onSubmit={(e) => void saveAddress(e)}>
        <label className="admin-invite-field">
          <span className="admin-invite-field-label">
            {de ? "IP-Adresse / Host" : "IP address / host"}
          </span>
          <input
            type="text"
            className="admin-invite-input"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="192.168.2.158"
            autoComplete="off"
          />
        </label>
        <label className="admin-invite-field">
          <span className="admin-invite-field-label">Port</span>
          <input
            type="number"
            className="admin-invite-input"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            min={1}
            max={65535}
          />
        </label>
        {settings?.configured && sourceLabel && (
          <div className="admin-settings-status">
            <span className="admin-settings-status-dot admin-settings-status-dot--ok" />
            {de
              ? `Aktiv: ${settings.host}:${settings.port} (${sourceLabel})`
              : `Active: ${settings.host}:${settings.port} (${sourceLabel})`}
          </div>
        )}
        <div className="admin-settings-form-actions">
          <button type="submit" className="admin-invite-submit" disabled={saving}>
            {saving ? (de ? "Speichern…" : "Saving…") : de ? "Speichern" : "Save"}
          </button>
          <button
            type="button"
            className="admin-invite-submit admin-invite-submit--secondary"
            onClick={() => void testPrint()}
            disabled={testing}
            title={
              activeMaterial
                ? de
                  ? `Druckt auf: ${activeMaterial.name}`
                  : `Prints on: ${activeMaterial.name}`
                : undefined
            }
          >
            {testing ? (de ? "Drucke…" : "Printing…") : de ? "Testdruck" : "Test print"}
          </button>
        </div>
      </form>

      {settings && (
        <div className="admin-settings-subsection">
          <label className="lc-check">
            <input
              type="checkbox"
              checked={settings.label_calibration_staff_enabled}
              disabled={saving}
              onChange={(e) => void toggleStaff(e.target.checked)}
            />
            <span>
              {de
                ? "Schnellablauf „Material gewechselt“ für die Werkstatt freigeben"
                : "Release the quick flow \"Material changed\" to the workshop"}
            </span>
          </label>
          <p className="lc-small">
            {de
              ? "Erst freigeben, wenn die Praxistests T0b, T1, T2 und T5 Ergebnisse haben. Bis dahin sehen nur Administratoren den Schnellablauf."
              : "Release only once the field tests T0b, T1, T2 and T5 have results. Until then only administrators see the quick flow."}
          </p>
        </div>
      )}

      {/* ── Material (what is physically loaded) ─────────────────────────── */}
      {settings && (
        <div className="admin-settings-subsection">
          <h3 className="admin-settings-subtitle">
            {de ? "Eingelegtes Material" : "Loaded material"}
          </h3>
          <p className="admin-tools-desc">
            {de
              ? "Der Drucker erkennt das Material nicht selbst — nach jedem Rollenwechsel hier umstellen und „Material gewechselt“ ausführen. Das Layout passt sich automatisch an."
              : "The printer cannot identify its material — switch here after every roll change and run \"Material changed\". Layouts adapt automatically."}
          </p>
          <PrinterStatusPanel compact />
          {running && (
            <p className="lc-warn">
              {de
                ? `Einrichtung läuft: ${running.user_name} (${running.mode === "full" ? "Vollständig" : "Schnell"}) seit ${formatLocalTime(running.acquired_at)}`
                : `Setup running: ${running.user_name} (${running.mode === "full" ? "full" : "quick"}) since ${formatLocalTime(running.acquired_at)}`}
            </p>
          )}
          <ul className="admin-settings-material-list">
            {settings.materials.map((material) => {
              const active = material.id === settings.active_material_id;
              const tier = TIER_LABELS[material.tier];
              return (
                <li
                  key={material.id}
                  className={`admin-settings-material lc-material-row${active ? " admin-settings-material--active" : ""}`}
                >
                  <label className="admin-settings-material-main">
                    <input
                      type="radio"
                      name="label-material"
                      checked={active}
                      disabled={saving}
                      onChange={() => void selectMaterial(material)}
                    />
                    <span className="admin-settings-material-name">
                      <b>{material.name}</b>
                      <small>
                        {material.part_no ? `${material.part_no} · ` : ""}
                        {dimensionLabel(material, de)}
                        {tier ? ` · ${de ? tier.de : tier.en}` : ""}
                      </small>
                      <small className="lc-row-info">{loadingLine(material, de)}</small>
                      <span>
                        <CalibrationChip calibration={material.calibration} de={de} />
                      </span>
                    </span>
                  </label>
                  <div className="lc-row-actions">
                    <button type="button" className="werkstatt-card-action" onClick={() => setQuickFor(material.id)}>
                      {de ? "Material gewechselt" : "Material changed"}
                    </button>
                    <button type="button" className="werkstatt-card-action" onClick={() => setWizardFor(material.id)}>
                      {de ? "Einrichten" : "Set up"}
                    </button>
                    <button type="button" className="werkstatt-card-action" onClick={() => setEditFor(material.id)}>
                      {de ? "Bearbeiten" : "Edit"}
                    </button>
                    {!material.builtin && (
                      <button
                        type="button"
                        className="werkstatt-card-action"
                        disabled={saving}
                        onClick={() => void removeMaterial(material)}
                      >
                        {de ? "Entfernen" : "Remove"}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {rollChanged && (
            <p className="lc-info">
              {de ? "Rolle gewechselt? " : "Roll changed? "}
              <button type="button" className="lc-link-btn" onClick={() => setQuickFor(settings.active_material_id)}>
                {de ? "Material gewechselt …" : "Material changed …"}
              </button>
            </p>
          )}
          {addOpen ? (
            <form className="admin-settings-form" onSubmit={(e) => void addMaterial(e)}>
              <label className="admin-invite-field">
                <span className="admin-invite-field-label">Name</span>
                <input
                  type="text"
                  className="admin-invite-input"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={de ? "z. B. Fremdetikett 38 × 23" : "e.g. label 38 × 23"}
                  required
                  maxLength={60}
                />
              </label>
              <label className="admin-invite-field">
                <span className="admin-invite-field-label">
                  {de ? "Artikelnummer (optional)" : "Part no. (optional)"}
                </span>
                <input
                  type="text"
                  className="admin-invite-input"
                  value={newPartNo}
                  onChange={(e) => setNewPartNo(e.target.value)}
                  maxLength={40}
                />
              </label>
              <label className="admin-invite-field">
                <span className="admin-invite-field-label">
                  {de ? "Breite (mm, quer zum Druckkopf, max. 47)" : "Width (mm, across head, max 47)"}
                </span>
                <input
                  type="text"
                  className="admin-invite-input"
                  value={newWidth}
                  onChange={(e) => setNewWidth(e.target.value)}
                  placeholder="25"
                  required
                />
              </label>
              <label className="admin-invite-field">
                <span className="admin-invite-field-label">
                  {de ? "Länge (mm) — leer für Endlos" : "Length (mm) — empty for continuous"}
                </span>
                <input
                  type="text"
                  className="admin-invite-input"
                  value={newLength}
                  onChange={(e) => setNewLength(e.target.value)}
                  placeholder="50"
                />
              </label>
              <label className="admin-invite-field">
                <span className="admin-invite-field-label">
                  {de ? "Spalt zwischen Etiketten (mm)" : "Gap between labels (mm)"}
                </span>
                <input
                  type="text"
                  className="admin-invite-input"
                  value={newGap}
                  onChange={(e) => setNewGap(e.target.value)}
                />
              </label>
              <div className="admin-settings-form-actions">
                <button type="submit" className="admin-invite-submit" disabled={saving}>
                  {de ? "Material anlegen" : "Add material"}
                </button>
                <button
                  type="button"
                  className="admin-invite-submit admin-invite-submit--secondary"
                  onClick={() => setAddOpen(false)}
                >
                  {de ? "Abbrechen" : "Cancel"}
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              className="werkstatt-card-action"
              onClick={() => setAddOpen(true)}
            >
              + {de ? "Eigenes Material" : "Custom material"}
            </button>
          )}
        </div>
      )}

      {/* ── Free text (marking strips, shrink tube, any label) ───────────── */}
      {settings && (
        <div className="admin-settings-subsection">
          <h3 className="admin-settings-subtitle">
            {de ? "Freitext drucken" : "Print free text"}
          </h3>
          <p className="admin-tools-desc">
            {de
              ? "Für Beschriftungsstreifen (Hutschienen, TopJob-Klemmen) und Schrumpfschlauch — druckt auf dem aktiven Material."
              : "For marking strips (DIN rail, TopJob terminals) and shrink tube — prints on the active material."}
          </p>
          <form className="admin-settings-form" onSubmit={(e) => void printFreetext(e)}>
            <label className="admin-invite-field">
              <span className="admin-invite-field-label">Text</span>
              <input
                type="text"
                className="admin-invite-input"
                value={freetext}
                onChange={(e) => setFreetext(e.target.value)}
                placeholder={de ? "z. B. F1 Herd 16A" : "e.g. F1 stove 16A"}
                maxLength={120}
                required
              />
            </label>
            <label className="admin-invite-field">
              <span className="admin-invite-field-label">
                {de ? "Anzahl" : "Copies"}
              </span>
              <input
                type="number"
                className="admin-invite-input"
                value={freetextCopies}
                onChange={(e) => setFreetextCopies(e.target.value)}
                min={1}
                max={50}
              />
            </label>
            <div className="admin-settings-form-actions">
              <button
                type="submit"
                className="admin-invite-submit"
                disabled={freetextBusy || !freetext.trim()}
              >
                {freetextBusy ? (de ? "Drucke…" : "Printing…") : de ? "Drucken" : "Print"}
              </button>
            </div>
          </form>
        </div>
      )}

      {feedback && (
        <div className="admin-settings-status">
          <span
            className={`admin-settings-status-dot${
              feedback.ok ? " admin-settings-status-dot--ok" : ""
            }`}
          />
          {feedback.text}
        </div>
      )}

      {quickFor !== undefined && (
        <MaterialChangeSheet
          preselectId={quickFor}
          onClose={() => {
            setQuickFor(undefined);
            setRollChanged(false);
            void load();
          }}
        />
      )}
      {wizardFor && settings && (
        <CalibrationWizard
          materialId={wizardFor}
          settings={settings}
          onSettings={adopt}
          onClose={() => {
            setWizardFor(null);
            void load();
          }}
        />
      )}
      {editing && settings && (
        <div className="werkstatt-modal-backdrop lc-backdrop" role="presentation">
          <div
            className="werkstatt-modal werkstatt-modal--wide lc-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={de ? `Material bearbeiten: ${editing.name}` : `Edit material: ${editing.name}`}
          >
            <header className="werkstatt-modal-head">
              <h2 className="werkstatt-modal-title">
                {de ? `Material bearbeiten: ${editing.name}` : `Edit material: ${editing.name}`}
              </h2>
            </header>
            <div className="werkstatt-modal-body">
              <LabelMaterialForm
                key={editing.id}
                material={editing}
                revision={settings.revision}
                onSaved={(saved) => {
                  if (saved) adopt(saved);
                  setEditFor(null);
                }}
                onCancel={() => setEditFor(null)}
                onReload={() => void load()}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
