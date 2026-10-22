import { useEffect, useId, useRef, useState } from "react";

import type { Language } from "../../types";
import type { DashboardDevice, DashboardLayout, DashboardState, DashboardWidgetItem } from "../../types/dashboard";
import { DashboardEditor } from "./DashboardEditor";
import { DASHBOARD_DEVICE_LABEL } from "./widgetMeta";

/**
 * „Startseite anpassen“: the user's edit mode around the shared editor
 * (docs/DASHBOARD.md §8.2).
 *
 * Its own lazy chunk, loaded on „Anpassen“: it pulls in the editor, the add
 * dialog and @dnd-kit, none of which the everyday overview needs (D12). It is
 * presentational — the host owns the draft, the frozen device and every
 * request — so it holds only the reset confirmation.
 */
export type DashboardEditModeProps = {
  /** The device the edit started on; frozen until „Fertig“ or „Abbrechen“. */
  device: DashboardDevice;
  /** The loaded layout of that device: the source badge and whether reset is possible. */
  layout: DashboardLayout;
  state: DashboardState;
  draft: DashboardWidgetItem[];
  onDraftChange: (next: DashboardWidgetItem[]) => void;
  onCancel: () => void;
  onDone: () => void;
  /** Called after the user confirmed; sends the DELETE. */
  onReset: () => void;
  busy: boolean;
  error: string | null;
  restored: boolean;
  language: Language;
};

export function DashboardEditMode({
  device,
  layout,
  state,
  draft,
  onDraftChange,
  onCancel,
  onDone,
  onReset,
  busy,
  error,
  restored,
  language,
}: DashboardEditModeProps): JSX.Element {
  const de = language === "de";
  const [confirming, setConfirming] = useState(false);
  const deviceName = de ? DASHBOARD_DEVICE_LABEL[device].de : DASHBOARD_DEVICE_LABEL[device].en;
  const personal = layout.source === "user";

  return (
    <div className="dashboard-edit" data-device={device}>
      <header className="dashboard-edit__head">
        <div className="dashboard-edit__heading">
          <h2 className="dashboard-edit__title">
            {de ? `Startseite anpassen · ${deviceName}` : `Customise start page · ${deviceName}`}
          </h2>
          <p className="dashboard-edit__hint">
            {de
              ? "Ziehe Widgets am Griff oder nutze die Pfeile. Gilt für alle deine Geräte dieser Größe."
              : "Drag widgets by the handle or use the arrows. Applies to all your devices of this size."}
          </p>
        </div>
        <span className={`dashboard-badge${personal ? " dashboard-badge--personal" : ""}`}>
          {personal ? (de ? "Persönlich angepasst" : "Personalised") : de ? "Standard deiner Rolle" : "Your role's default"}
        </span>
      </header>

      {restored ? (
        <p className="dashboard-notice" role="status">
          {de ? "Deine nicht gespeicherten Änderungen sind wiederhergestellt." : "Your unsaved changes have been restored."}
        </p>
      ) : null}
      {error ? (
        <p className="dashboard-notice dashboard-notice--error" role="alert">
          {error}
        </p>
      ) : null}

      <DashboardEditor
        device={device}
        widgets={draft}
        onChange={onDraftChange}
        availableIds={state.available_widgets}
        defaultSizes={state.default_sizes}
        language={language}
        toolbar={
          <>
            <button
              type="button"
              className="dashboard-button"
              disabled={!personal || busy}
              onClick={() => setConfirming(true)}
            >
              {de ? "Auf Standard zurücksetzen" : "Reset to default"}
            </button>
            <span className="dashboard-editor__spacer" aria-hidden="true" />
            <button type="button" className="dashboard-button" disabled={busy} onClick={onCancel}>
              {de ? "Abbrechen" : "Cancel"}
            </button>
            <button
              type="button"
              className="dashboard-button dashboard-button--primary"
              disabled={busy}
              aria-busy={busy}
              onClick={onDone}
            >
              {de ? "Fertig" : "Done"}
            </button>
          </>
        }
      />

      {confirming ? (
        <ResetConfirm
          deviceName={deviceName}
          de={de}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            onReset();
          }}
        />
      ) : null}
    </div>
  );
}

function ResetConfirm({
  deviceName,
  de,
  onCancel,
  onConfirm,
}: {
  deviceName: string;
  de: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const textId = useId();
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // The safe choice has the focus: Enter right after opening must not wipe the layout.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <section
        className="card modal-card modal-card-sm dashboard-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <h3 id={titleId}>{de ? "Auf Standard zurücksetzen" : "Reset to default"}</h3>
        <p id={textId}>
          {de
            ? `Startseite für ${deviceName} auf den Standard deiner Rolle zurücksetzen? Deine Anpassungen für diese Gerätegröße gehen verloren.`
            : `Reset the start page for ${deviceName} to your role's default? Your changes for this device size will be lost.`}
        </p>
        <div className="dashboard-confirm__actions">
          <button ref={cancelRef} type="button" className="dashboard-button" onClick={onCancel}>
            {de ? "Abbrechen" : "Cancel"}
          </button>
          <button type="button" className="dashboard-button dashboard-button--primary" onClick={onConfirm}>
            {de ? "Zurücksetzen" : "Reset"}
          </button>
        </div>
      </section>
    </div>
  );
}
