/**
 * "Reihe aus Vorlage" — pick a pre-populated rail.
 *
 * Same bottom sheet as the device palette, for the same reason: it is the
 * reachable third of a phone screen. Four entries, no sections; the list is
 * short enough to read whole. What each template numbers and rates is
 * decided in `utils/schaltplanDocumentOps.ts`, not here.
 */
import { ROW_TEMPLATES, type RowTemplateId } from "../../utils/schaltplanDocumentOps";

type Props = {
  open: boolean;
  onPick: (templateId: RowTemplateId) => void;
  onClose: () => void;
};

export function RowTemplateSheet({ open, onPick, onClose }: Props) {
  if (!open) return null;

  return (
    <>
      <div className="sp-sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="sp-sheet" role="dialog" aria-modal="true" aria-label="Reihe aus Vorlage">
        <div className="sp-sheet-head">
          <div>
            <h3>Reihe aus Vorlage</h3>
            <small>BMK, Stromkreis-Nr. und Phasen werden fortlaufend vergeben</small>
          </div>
          <button type="button" className="sp-sheet-close" onClick={onClose} aria-label="Schließen">
            ×
          </button>
        </div>

        <div className="sp-sheet-body">
          <div className="sp-palette-grid">
            {ROW_TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                className="sp-palette-item"
                onClick={() => onPick(template.id)}
              >
                <span className="sp-palette-text">
                  <b>{template.label}</b>
                  <small>{template.hint}</small>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
