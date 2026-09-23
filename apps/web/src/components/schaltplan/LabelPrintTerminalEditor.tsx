/**
 * The marker texts of the selected strips, one input each — the editing
 * list under the Reihenklemmen preview.
 *
 * Every marker the derivation numbered can be overridden in the document
 * (`terminal_labels`, keyed by `overrideKey`): the owner wants "1.3" to
 * read "7" on one board and the Block's name row to say what the customer
 * calls the thing. The input shows the override where there is one and the
 * derived text where there is none; the placeholder is always the default,
 * so a cleared field reads "prints nothing, would default to 1.3".
 * "Zurücksetzen" removes the override — the marker falls back to its
 * default — and is the only way back from a blank, because a blank is a
 * deliberate "no text" (like an unnamed device on the BMK strip).
 *
 * Edits go to the parent as `(key, value | null)`; the parent writes the
 * document through its normal autosave path, which is what the printer
 * reads. No local state here — the preview above updates from the same
 * document on the next render.
 */
import { FEED_PART_IDS } from "../../utils/schaltplanTerminalRules";
import {
  STRIP_KIND_BLOCK,
  labelOverrides,
  type TerminalEntry,
  type TerminalGroup,
  type TerminalStrip,
} from "../../utils/schaltplanTerminals";
import { findDevice } from "../../utils/schaltplanTopology";
import type { PanelDocument } from "../../types/schaltplan";

type Props = {
  groups: readonly TerminalGroup[];
  /** The ticked strips — the ones the preview shows. */
  selectedIds: readonly string[];
  document: PanelDocument;
  readOnly: boolean;
  /** `value` null removes the override; "" keeps a blank one. */
  onEdit: (key: string, value: string | null) => void;
};

/** "F1.1 Steckdosen Küche" / "FI F1" — what the marker is for, after the part number. */
function markerSubject(terminal: TerminalEntry, group: TerminalGroup, document: PanelDocument): string {
  if (FEED_PART_IDS.has(terminal.partId) && group.headDevice && terminal.deviceId === group.headDevice.id) {
    return `FI ${group.headDevice.designation.trim() || "?"}`;
  }
  const device = findDevice(document, terminal.deviceId);
  if (!device) return terminal.pole ?? "";
  const subject = `${device.designation.trim()} ${device.label.trim()}`.trim();
  return terminal.pole ? `${terminal.pole}${subject ? ` · ${subject}` : ""}` : subject;
}

/** What the Block's name row says without an override: the description, else the designation. */
function blockNameFallback(strip: TerminalStrip, document: PanelDocument): string {
  const device = findDevice(document, strip.deviceId);
  return device ? device.label.trim() || device.designation.trim() : "";
}

/** "X1 · Pos. 2 · 2003-7641 · F1.1 Steckdosen Küche" — the input's label. */
export function markerRowLabel(strip: TerminalStrip, terminal: TerminalEntry, group: TerminalGroup, document: PanelDocument): string {
  const subject = markerSubject(terminal, group, document);
  return [`X${strip.stripNo}`, `Pos. ${terminal.position}`, terminal.partId, subject].filter(Boolean).join(" · ");
}

type RowProps = {
  label: string;
  overrideKey: string;
  /** The text the marker prints now (override applied). */
  current: string;
  /** The text it would print without an override. */
  fallback: string;
  overrides: Readonly<Record<string, string>>;
  readOnly: boolean;
  onEdit: Props["onEdit"];
};

function MarkerRow({ label, overrideKey, current, fallback, overrides, readOnly, onEdit }: RowProps) {
  const overridden = overrideKey in overrides;
  return (
    <li className={overridden ? "sp-marker-edit sp-marker-edit--overridden" : "sp-marker-edit"}>
      <label className="sp-marker-edit-main">
        <span className="sp-marker-edit-label">{label}</span>
        <input
          type="text"
          className="sp-marker-edit-input"
          value={overridden ? overrides[overrideKey] : current}
          placeholder={fallback}
          disabled={readOnly}
          onChange={(event) => onEdit(overrideKey, event.target.value)}
        />
      </label>
      <button
        type="button"
        className="sp-marker-edit-reset"
        disabled={readOnly || !overridden}
        onClick={() => onEdit(overrideKey, null)}
        aria-label={`${label} zurücksetzen`}
        title="Auf den abgeleiteten Text zurücksetzen"
      >
        Zurücksetzen
      </button>
    </li>
  );
}

export function TerminalLabelEditor({ groups, selectedIds, document, readOnly, onEdit }: Props) {
  const overrides = labelOverrides(document);
  const strips = groups.flatMap((group) => group.strips.map((strip) => ({ group, strip })));
  const selected = strips.filter(({ strip }) => selectedIds.includes(strip.stripId));
  if (selected.length === 0) return null;

  return (
    <section className="sp-marker-editor" aria-label="Beschriftung">
      <div className="sp-label-rows-head">
        <span className="sp-field-label">Beschriftung</span>
        <small className="sp-label-summary">Leer = kein Text · Zurücksetzen = abgeleiteter Text</small>
      </div>
      {selected.map(({ group, strip }) => (
        <div key={strip.stripId} className="sp-marker-editor-strip">
          <b className="sp-marker-editor-title">{strip.title}</b>
          <ul className="sp-marker-edit-rows">
            {strip.kind === STRIP_KIND_BLOCK && (
              <>
                <MarkerRow
                  label={`X${strip.stripNo} · Name`}
                  overrideKey={strip.nameKey}
                  current={strip.name}
                  fallback={blockNameFallback(strip, document)}
                  overrides={overrides}
                  readOnly={readOnly}
                  onEdit={onEdit}
                />
                <MarkerRow
                  label={`X${strip.stripNo} · X`}
                  overrideKey={strip.xKey}
                  current={strip.xLabel}
                  fallback={`X${strip.stripNo}`}
                  overrides={overrides}
                  readOnly={readOnly}
                  onEdit={onEdit}
                />
              </>
            )}
            {strip.terminals
              .filter((terminal) => terminal.marker && terminal.key !== "")
              .map((terminal) => (
                <MarkerRow
                  key={terminal.key}
                  label={markerRowLabel(strip, terminal, group, document)}
                  overrideKey={terminal.key}
                  current={terminal.label}
                  fallback={terminal.defaultLabel}
                  overrides={overrides}
                  readOnly={readOnly}
                  onEdit={onEdit}
                />
              ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
