/**
 * The open Verteiler's identity line and its actions: save state, the plan
 * PDFs, both label printers, Bestand/Entwurf and Duplizieren.
 *
 * The PDFs stay links (long-press "in neuem Tab öffnen" still works), but a
 * plain tap goes through `openAfterSave`: the server draws them from the
 * saved document, and the last edit may still be waiting for autosave.
 */
import { OWN_OPENER_PROPS, savedPdfClick } from "../../utils/openAfterSave";
import { PANEL_TYPE_LABELS } from "../../utils/schaltplanDevices";
import { panelPdfUrl } from "../../utils/schaltplanApi";
import type { SaveState } from "../../hooks/usePanelDocumentEditor";
import type { PanelPlan } from "../../types/schaltplan";

const SAVE_LABELS: Record<SaveState, string> = {
  clean: "Gespeichert",
  pending: "Änderungen…",
  saving: "Speichert…",
  error: "Nicht gespeichert",
};

export type PanelEditorHeaderProps = {
  panel: PanelPlan;
  saveState: SaveState;
  canEdit: boolean;
  labelsPrinting: boolean;
  typeLabelPrinting: boolean;
  /** The editor's `settleSaves`: true once the server holds the latest edits. */
  settleSaves: () => Promise<boolean>;
  onError: (message: string) => void;
  onOpenBmkLabels: () => void;
  onOpenTypeLabel: () => void;
  onToggleStatus: () => void;
  onDuplicate: () => void;
};

function PdfLink({
  href,
  label,
  settleSaves,
  onError,
}: {
  href: string;
  label: string;
  settleSaves: () => Promise<boolean>;
  onError: (message: string) => void;
}) {
  return (
    // OWN_OPENER_PROPS: on the app surfaces the in-app viewer must not open it before the saves settled.
    <a
      className="sp-btn"
      href={href}
      target="_blank"
      rel="noreferrer"
      {...OWN_OPENER_PROPS}
      onClick={savedPdfClick(href, settleSaves, onError, label)}
    >
      {label}
    </a>
  );
}

function PanelIdentity({ panel }: { panel: PanelPlan }) {
  return (
    <div className="sp-editor-identity">
      <span className={`sp-panel-badge sp-panel-badge--${panel.panel_type}`}>{panel.designation}</span>
      <div>
        <h3>{panel.name}</h3>
        <small>
          {PANEL_TYPE_LABELS[panel.panel_type]}
          {panel.location ? ` · ${panel.location}` : ""}
          {panel.fed_from_designation ? ` · eingespeist von ${panel.fed_from_designation}` : ""}
        </small>
      </div>
    </div>
  );
}

export function PanelEditorHeader({
  panel,
  saveState,
  canEdit,
  labelsPrinting,
  typeLabelPrinting,
  settleSaves,
  onError,
  onOpenBmkLabels,
  onOpenTypeLabel,
  onToggleStatus,
  onDuplicate,
}: PanelEditorHeaderProps): JSX.Element {
  return (
    <header className="sp-editor-head">
      <PanelIdentity panel={panel} />

      <div className="sp-editor-actions">
        <span className={`sp-save sp-save--${saveState}`} role="status">
          {SAVE_LABELS[saveState]}
        </span>
        <PdfLink href={panelPdfUrl(panel.id)} label="Plan als PDF" settleSaves={settleSaves} onError={onError} />
        <PdfLink
          href={panelPdfUrl(panel.id, { legendOnly: true })}
          label="Legende drucken"
          settleSaves={settleSaves}
          onError={onError}
        />
        <button
          type="button"
          className="sp-btn"
          disabled={labelsPrinting}
          onClick={onOpenBmkLabels}
          title="Ein Etikett je Betriebsmittelkennzeichen — Reihen und Material in der Vorschau wählen"
        >
          {labelsPrinting ? "Drucke…" : "BMK-Etiketten"}
        </button>
        <button
          type="button"
          className="sp-btn"
          disabled={typeLabelPrinting}
          onClick={onOpenTypeLabel}
          title="Typenschild des Verteilers auf dem Etikettendrucker drucken"
        >
          {typeLabelPrinting ? "Drucke…" : "Schrank-Etikett"}
        </button>
        {canEdit && (
          <button type="button" className="sp-btn" onClick={onToggleStatus}>
            {panel.status === "final" ? "Auf Entwurf setzen" : "Als Bestand markieren"}
          </button>
        )}
        {canEdit && (
          <button type="button" className="sp-btn" onClick={onDuplicate}>
            Duplizieren
          </button>
        )}
      </div>
    </header>
  );
}
