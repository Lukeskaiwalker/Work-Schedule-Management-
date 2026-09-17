/**
 * The "Daten" tab: the supply block and the panel's own fields.
 *
 * Pulled out of SchaltplanPage so the page stays an orchestrator. Supply
 * fields patch the document (autosaved like every other edit); the panel
 * fields save on blur through `onSaveMeta`, because a designation is
 * unique per customer and a keystroke-by-keystroke PATCH would race the
 * 409. Deleting confirms here and lets the page do the request.
 */
import { PANEL_TYPE_LABELS, SUPPLY_SYSTEMS } from "../../utils/schaltplanDevices";
import type { UpdatePanelPayload } from "../../utils/schaltplanApi";
import type { PanelDocument, PanelPlan, PanelPlanSummary, PanelSupply, PanelType } from "../../types/schaltplan";

type Props = {
  panel: PanelPlan;
  document: PanelDocument;
  /** Every panel of the customer — candidates for "Eingespeist von". */
  panels: PanelPlanSummary[];
  readOnly: boolean;
  canEdit: boolean;
  onPatchSupply: (patch: Partial<PanelSupply>) => void;
  onSaveMeta: (patch: UpdatePanelPayload) => void | Promise<void>;
  onDelete: () => void | Promise<void>;
};

export function PanelDataTab({ panel, document, panels, readOnly, canEdit, onPatchSupply, onSaveMeta, onDelete }: Props) {
  return (
    <div className="sp-data">
      <section className="sp-data-block">
        <h4>Einspeisung</h4>
        <div className="sp-field-grid">
          <label className="sp-field">
            <span className="sp-field-label">Netzform</span>
            <select
              value={document.supply.system}
              disabled={readOnly}
              onChange={(event) => onPatchSupply({ system: event.target.value as PanelSupply["system"] })}
            >
              {SUPPLY_SYSTEMS.map((system) => (
                <option key={system} value={system}>
                  {system}
                </option>
              ))}
            </select>
          </label>
          <label className="sp-field">
            <span className="sp-field-label">Spannung</span>
            <input
              type="text"
              value={document.supply.voltage}
              disabled={readOnly}
              onChange={(event) => onPatchSupply({ voltage: event.target.value })}
            />
          </label>
          <label className="sp-field">
            <span className="sp-field-label">Zuleitung</span>
            <input
              type="text"
              value={document.supply.incoming}
              disabled={readOnly}
              placeholder="NYY-J 5x16 mm²"
              onChange={(event) => onPatchSupply({ incoming: event.target.value })}
            />
          </label>
          <label className="sp-field">
            <span className="sp-field-label">Vorsicherung</span>
            <input
              type="text"
              value={document.supply.fuse}
              disabled={readOnly}
              placeholder="NH 63 A"
              onChange={(event) => onPatchSupply({ fuse: event.target.value })}
            />
          </label>
          <label className="sp-field">
            <span className="sp-field-label">Zählernummer</span>
            <input
              type="text"
              value={document.supply.meter_number}
              disabled={readOnly}
              onChange={(event) => onPatchSupply({ meter_number: event.target.value })}
            />
          </label>
        </div>
      </section>

      <section className="sp-data-block">
        <h4>Verteiler</h4>
        <div className="sp-field-grid">
          <label className="sp-field">
            <span className="sp-field-label">Bezeichnung</span>
            <input
              type="text"
              defaultValue={panel.designation}
              disabled={readOnly}
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (value && value !== panel.designation) void onSaveMeta({ designation: value });
              }}
            />
          </label>
          <label className="sp-field">
            <span className="sp-field-label">Name</span>
            <input
              type="text"
              defaultValue={panel.name}
              disabled={readOnly}
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (value && value !== panel.name) void onSaveMeta({ name: value });
              }}
            />
          </label>
          <label className="sp-field">
            <span className="sp-field-label">Ort</span>
            <input
              type="text"
              defaultValue={panel.location ?? ""}
              disabled={readOnly}
              onBlur={(event) => void onSaveMeta({ location: event.target.value.trim() })}
            />
          </label>
          <label className="sp-field">
            <span className="sp-field-label">Art</span>
            <select
              value={panel.panel_type}
              disabled={readOnly}
              onChange={(event) => void onSaveMeta({ panel_type: event.target.value as PanelType })}
            >
              {(["main", "sub", "meter"] as PanelType[]).map((type) => (
                <option key={type} value={type}>
                  {PANEL_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </label>
          <label className="sp-field">
            <span className="sp-field-label">Eingespeist von</span>
            <select
              value={panel.fed_from_panel_id ?? ""}
              disabled={readOnly}
              onChange={(event) =>
                void onSaveMeta({ fed_from_panel_id: event.target.value ? Number(event.target.value) : null })
              }
            >
              <option value="">Netz / Hausanschluss</option>
              {panels
                .filter((row) => row.id !== panel.id)
                .map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.designation} — {row.name}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <label className="sp-field">
          <span className="sp-field-label">Notizen</span>
          <textarea
            rows={3}
            defaultValue={panel.notes ?? ""}
            disabled={readOnly}
            onBlur={(event) => void onSaveMeta({ notes: event.target.value })}
          />
        </label>
      </section>

      {canEdit && (
        <section className="sp-data-block sp-data-block--danger">
          <h4>Verteiler löschen</h4>
          <p>Entfernt den Plan mit allen Stromkreisen. Nur der Ersteller oder die Projektleitung kann das.</p>
          <button
            type="button"
            className="sp-btn sp-btn--danger"
            onClick={() => {
              if (!window.confirm(`Verteiler „${panel.designation}“ wirklich löschen?`)) return;
              void onDelete();
            }}
          >
            Löschen
          </button>
        </section>
      )}
    </div>
  );
}
