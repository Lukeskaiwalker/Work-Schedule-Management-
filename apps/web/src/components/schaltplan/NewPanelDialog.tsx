/**
 * Create a Verteiler.
 *
 * Kept to the five things that identify a board — type, Bezeichnung, name,
 * location, and which board feeds it. Everything else (supply data, devices)
 * is entered in the editor, because on the first site visit the electrician
 * is standing in front of an open panel and wants to start listing breakers,
 * not fill in a form.
 *
 * The Bezeichnung is pre-filled from the type ("HV" / "UV1") and made unique
 * against the boards already on file for this customer, so the common case is
 * two taps.
 */
import { useMemo, useState } from "react";

import { PANEL_TYPE_LABELS } from "../../utils/schaltplanDevices";
import type { PanelPlanSummary, PanelType } from "../../types/schaltplan";

type Props = {
  customerName: string;
  projectLabel: string | null;
  existing: PanelPlanSummary[];
  busy: boolean;
  onCancel: () => void;
  onCreate: (payload: {
    name: string;
    designation: string;
    panel_type: PanelType;
    location: string;
    fed_from_panel_id: number | null;
  }) => void;
};

function suggestDesignation(type: PanelType, existing: PanelPlanSummary[]): string {
  const taken = new Set(existing.map((panel) => panel.designation.toUpperCase()));
  const base = type === "main" ? "HV" : type === "meter" ? "ZP" : "UV";
  if (type === "main" && !taken.has("HV")) return "HV";
  for (let index = 1; index < 60; index += 1) {
    const candidate = type === "main" ? `HV${index}` : `${base}${index}`;
    if (!taken.has(candidate.toUpperCase())) return candidate;
  }
  return base;
}

export function NewPanelDialog({
  customerName,
  projectLabel,
  existing,
  busy,
  onCancel,
  onCreate,
}: Props) {
  const [panelType, setPanelType] = useState<PanelType>("sub");
  const [designationTouched, setDesignationTouched] = useState(false);
  const [designation, setDesignation] = useState(() => suggestDesignation("sub", existing));
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [fedFrom, setFedFrom] = useState<string>("");

  const mainPanels = useMemo(
    () => existing.filter((panel) => panel.panel_type !== "sub"),
    [existing],
  );

  const changeType = (next: PanelType) => {
    setPanelType(next);
    // Only re-suggest while the field is untouched — silently rewriting a
    // Bezeichnung the electrician typed would be worse than a wrong default.
    if (!designationTouched) setDesignation(suggestDesignation(next, existing));
  };

  const canSubmit = designation.trim().length > 0 && name.trim().length > 0 && !busy;

  return (
    <>
      <div className="sp-sheet-backdrop" onClick={busy ? undefined : onCancel} aria-hidden="true" />
      <div className="sp-sheet sp-sheet--dialog" role="dialog" aria-modal="true" aria-label="Neuer Verteiler">
        <div className="sp-sheet-head">
          <div>
            <h3>Neuer Verteiler</h3>
            <small>{[customerName, projectLabel].filter(Boolean).join(" · ")}</small>
          </div>
          <button type="button" className="sp-sheet-close" onClick={onCancel} aria-label="Schließen">
            ×
          </button>
        </div>

        <form
          className="sp-sheet-body"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSubmit) return;
            onCreate({
              name: name.trim(),
              designation: designation.trim(),
              panel_type: panelType,
              location: location.trim(),
              fed_from_panel_id: fedFrom ? Number(fedFrom) : null,
            });
          }}
        >
          <div className="sp-type-switch" role="group" aria-label="Art des Verteilers">
            {(["main", "sub", "meter"] as PanelType[]).map((type) => (
              <button
                key={type}
                type="button"
                className={panelType === type ? "sp-type-btn sp-type-btn--active" : "sp-type-btn"}
                onClick={() => changeType(type)}
              >
                {PANEL_TYPE_LABELS[type]}
              </button>
            ))}
          </div>

          <div className="sp-field-grid">
            <label className="sp-field">
              <span className="sp-field-label">Bezeichnung *</span>
              <input
                type="text"
                value={designation}
                onChange={(event) => {
                  setDesignationTouched(true);
                  setDesignation(event.target.value);
                }}
                placeholder="UV1"
                maxLength={32}
                required
              />
            </label>
            <label className="sp-field">
              <span className="sp-field-label">Ort</span>
              <input
                type="text"
                value={location}
                onChange={(event) => setLocation(event.target.value)}
                placeholder="Keller, Raum 0.3"
                maxLength={255}
              />
            </label>
          </div>

          <label className="sp-field">
            <span className="sp-field-label">Name *</span>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Unterverteiler Werkstatt"
              maxLength={160}
              required
            />
          </label>

          {panelType !== "main" && mainPanels.length > 0 && (
            <label className="sp-field">
              <span className="sp-field-label">Eingespeist von</span>
              <select value={fedFrom} onChange={(event) => setFedFrom(event.target.value)}>
                <option value="">Netz / Hausanschluss</option>
                {mainPanels.map((panel) => (
                  <option key={panel.id} value={panel.id}>
                    {panel.designation} — {panel.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="sp-sheet-actions">
            <button type="button" className="sp-btn" onClick={onCancel} disabled={busy}>
              Abbrechen
            </button>
            <button type="submit" className="sp-btn sp-btn--primary" disabled={!canSubmit}>
              {busy ? "Wird angelegt…" : "Verteiler anlegen"}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
