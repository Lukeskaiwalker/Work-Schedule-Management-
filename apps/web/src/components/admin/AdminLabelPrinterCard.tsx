/**
 * AdminLabelPrinterCard — Werkstatt label printer setup in the admin settings.
 *
 * Self-contained on purpose (own fetches, own state) rather than following the
 * weather/OpenAI pattern of App.tsx-owned state: App.tsx is a 9k-line file
 * under active parallel work, and this card has no reason to couple to it.
 *
 * Three concerns live here, in the order an admin meets them:
 *   1. the printer's address (runtime-first, env fallback — `source` says
 *      which is in effect),
 *   2. the MATERIAL that is physically loaded: the printer can sense label
 *      gaps but not identity, so this selection is the software's only truth.
 *      Builtins cover the six workshop stocks; anything else is one form away.
 *   3. utilities: Testdruck (adapts to the active material's tier) and free
 *      text for continuous stock (marking strips, shrink tube).
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { apiFetch } from "../../api/client";
import { useAppContext } from "../../context/AppContext";

export interface LabelMaterial {
  id: string;
  name: string;
  part_no: string;
  width_mm: number;
  length_mm: number | null;
  gap_mm: number;
  x_offset_mm: number;
  darkness: number | null;
  builtin: boolean;
  tier: "voll" | "kompakt" | "mini";
  continuous: boolean;
}

export interface LabelPrinterSettings {
  host: string;
  port: number;
  configured: boolean;
  source: "runtime" | "env" | "none";
  materials: LabelMaterial[];
  active_material_id: string;
  active_material_name: string;
  active_tier: string;
}

interface TestResult {
  ok: boolean;
  printer: string;
  detail: string;
}

const TIER_LABELS: Record<string, { de: string; en: string }> = {
  voll: { de: "Voll (Logo + Code)", en: "Full (logo + code)" },
  kompakt: { de: "Kompakt (Code + Nr.)", en: "Compact (code + no.)" },
  mini: { de: "Mini (nur Nummer)", en: "Mini (number only)" },
};

/** "99 × 44 mm" or "11 mm Endlos" — how electricians read a box label. */
function dimensionLabel(material: LabelMaterial, de: boolean): string {
  if (material.continuous) {
    return `${material.width_mm} mm ${de ? "Endlos" : "continuous"}`;
  }
  return `${material.length_mm} × ${material.width_mm} mm`;
}

export function AdminLabelPrinterCard() {
  const { token, language } = useAppContext();
  const de = language === "de";

  const [settings, setSettings] = useState<LabelPrinterSettings | null>(null);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("9100");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPartNo, setNewPartNo] = useState("");
  const [newWidth, setNewWidth] = useState("");
  const [newLength, setNewLength] = useState("");
  const [newGap, setNewGap] = useState("3");

  const [freetext, setFreetext] = useState("");
  const [freetextCopies, setFreetextCopies] = useState("1");
  const [freetextBusy, setFreetextBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const current = await apiFetch<LabelPrinterSettings>(
        "/admin/settings/label-printer",
        token,
      );
      setSettings(current);
      setHost(current.host);
      setPort(String(current.port));
    } catch {
      // The card degrades to an empty form; saving will surface real errors.
      setSettings(null);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Every mutation goes through one PATCH so the payload stays consistent. */
  const patch = useCallback(
    async (
      body: Record<string, unknown>,
      successText: (saved: LabelPrinterSettings) => string,
    ) => {
      setSaving(true);
      setFeedback(null);
      try {
        const saved = await apiFetch<LabelPrinterSettings>(
          "/admin/settings/label-printer",
          token,
          {
            method: "PATCH",
            body: JSON.stringify({
              host: host.trim(),
              port: Number.parseInt(port, 10) || 9100,
              ...body,
            }),
          },
        );
        setSettings(saved);
        setHost(saved.host);
        setPort(String(saved.port));
        setFeedback({ ok: true, text: successText(saved) });
        return saved;
      } catch (err: unknown) {
        setFeedback({ ok: false, text: err instanceof Error ? err.message : String(err) });
        return null;
      } finally {
        setSaving(false);
      }
    },
    [token, host, port],
  );

  async function saveAddress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await patch({}, (saved) =>
      saved.configured
        ? de
          ? `Gespeichert — Drucker ${saved.host}:${saved.port}`
          : `Saved — printer ${saved.host}:${saved.port}`
        : de
          ? "Gespeichert — Etikettendruck deaktiviert"
          : "Saved — label printing disabled",
    );
  }

  async function activateMaterial(material: LabelMaterial) {
    await patch({ active_material_id: material.id }, () =>
      de
        ? `Aktives Material: ${material.name} — bitte auch physisch einlegen`
        : `Active material: ${material.name} — remember to load it physically`,
    );
  }

  async function addMaterial(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings) return;
    const width = Number.parseFloat(newWidth.replace(",", "."));
    const length = newLength.trim()
      ? Number.parseFloat(newLength.replace(",", "."))
      : null;
    const slug = `custom-${Date.now().toString(36)}`;
    const materials = [
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
    const materials = settings.materials
      .filter((m) => m.id !== material.id)
      .map((m) => ({ ...m }));
    await patch(
      {
        materials,
        // Deleting the active profile falls back to the default stock.
        active_material_id:
          settings.active_material_id === material.id
            ? "wago-210-804"
            : settings.active_material_id,
      },
      () => (de ? `Material „${material.name}“ entfernt` : `Material "${material.name}" removed`),
    );
  }

  async function testPrint() {
    setTesting(true);
    setFeedback(null);
    try {
      const result = await apiFetch<TestResult>(
        "/admin/settings/label-printer/test",
        token,
        { method: "POST" },
      );
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
      const result = await apiFetch<TestResult>(
        "/admin/settings/label-printer/freetext",
        token,
        {
          method: "POST",
          body: JSON.stringify({
            text: freetext.trim(),
            copies: Number.parseInt(freetextCopies, 10) || 1,
          }),
        },
      );
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

  const activeMaterial = settings?.materials.find(
    (m) => m.id === settings.active_material_id,
  );

  return (
    <div className="admin-page-card admin-settings-block">
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

      {/* ── Material (what is physically loaded) ─────────────────────────── */}
      {settings && (
        <div className="admin-settings-subsection">
          <h3 className="admin-settings-subtitle">
            {de ? "Eingelegtes Material" : "Loaded material"}
          </h3>
          <p className="admin-tools-desc">
            {de
              ? "Der Drucker erkennt das Material nicht selbst — nach jedem Rollenwechsel hier umstellen. Das Layout passt sich automatisch an."
              : "The printer cannot identify its material — switch here after every roll change. Layouts adapt automatically."}
          </p>
          <ul className="admin-settings-material-list">
            {settings.materials.map((material) => {
              const active = material.id === settings.active_material_id;
              const tier = TIER_LABELS[material.tier];
              return (
                <li
                  key={material.id}
                  className={`admin-settings-material${
                    active ? " admin-settings-material--active" : ""
                  }`}
                >
                  <label className="admin-settings-material-main">
                    <input
                      type="radio"
                      name="label-material"
                      checked={active}
                      disabled={saving}
                      onChange={() => void activateMaterial(material)}
                    />
                    <span className="admin-settings-material-name">
                      <b>{material.name}</b>
                      <small>
                        {material.part_no ? `${material.part_no} · ` : ""}
                        {dimensionLabel(material, de)}
                        {tier ? ` · ${de ? tier.de : tier.en}` : ""}
                      </small>
                    </span>
                  </label>
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
                </li>
              );
            })}
          </ul>
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
    </div>
  );
}
