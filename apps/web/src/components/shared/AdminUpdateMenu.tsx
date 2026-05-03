import { useEffect } from "react";
import { useAppContext } from "../../context/AppContext";

export function AdminUpdateMenu() {
  const {
    canManageSystem,
    language,
    currentReleaseLabel,
    updateStatus,
    updateStatusLoading,
    updateInstallRunning,
    updateProgress,
    setUpdateProgress,
    loadUpdateStatus,
    installSystemUpdate,
    activeUpdateJob,
    user,
  } = useAppContext();

  // Auto-fetch the update status the first time the System tab is opened in a session.
  // The component is conditionally rendered, so this fires when the admin lands on
  // the tab. Skipped when status is already cached (avoids a refetch on every tab
  // switch) and when an explicit refresh is already in flight.
  useEffect(() => {
    if (!canManageSystem) return;
    if (updateStatus !== null && updateStatus !== undefined) return;
    if (updateStatusLoading) return;
    void loadUpdateStatus(false);
    // We only want to run once per mount — the effect intentionally captures the
    // initial state and triggers a single fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManageSystem]);

  if (!canManageSystem) return null;

  const latestLabel =
    updateStatus?.latest_version || updateStatus?.latest_commit || (language === "de" ? "unbekannt" : "unknown");
  let statusLabel = language === "de" ? "Status unbekannt" : "Status unknown";
  if (updateStatus?.update_available === true) {
    statusLabel = language === "de" ? "Update verfügbar" : "Update available";
  } else if (updateStatus?.update_available === false) {
    statusLabel = language === "de" ? "Bereits aktuell" : "Up to date";
  }

  // Map runner job status to a localized human label. Falls back to the raw
  // status string for any future status values we haven't translated yet.
  const progressStatusLabel = (() => {
    if (!updateProgress) return null;
    const map: Record<string, { de: string; en: string }> = {
      queued: { de: "In Warteschlange", en: "Queued" },
      running: { de: "Läuft...", en: "Running..." },
      succeeded: { de: "Erfolgreich", en: "Succeeded" },
      failed: { de: "Fehlgeschlagen", en: "Failed" },
    };
    const entry = map[updateProgress.status];
    return entry ? entry[language === "de" ? "de" : "en"] : updateProgress.status;
  })();

  const isTerminalProgress =
    updateProgress?.status === "succeeded" || updateProgress?.status === "failed";

  // v2.4.6: cross-admin banner — when an update is running and a
  // DIFFERENT admin started it, surface their name so the local
  // operator knows who's driving (instead of just seeing "Running").
  // user?.id is checked to avoid showing the banner on the originator's
  // own tab (where the buttons already say "Installing...").
  const isRemoteUpdate = Boolean(
    activeUpdateJob?.job_id &&
      activeUpdateJob.started_by_user_id !== null &&
      activeUpdateJob.started_by_user_id !== undefined &&
      user?.id !== activeUpdateJob.started_by_user_id,
  );
  const remoteAdminName = activeUpdateJob?.started_by_display_name?.trim() || "";

  return (
    <div className="metric-stack admin-update-tools">
      <b>{language === "de" ? "System-Updates" : "System updates"}</b>
      {isRemoteUpdate && (
        <small
          className="muted"
          style={{
            display: "block",
            padding: "6px 10px",
            background: "#fff7e6",
            border: "1px solid #f6c97a",
            borderRadius: 6,
            color: "#7a4f00",
          }}
        >
          {remoteAdminName
            ? language === "de"
              ? `${remoteAdminName} installiert gerade ein Update`
              : `${remoteAdminName} is installing an update right now`
            : language === "de"
              ? "Ein anderer Admin installiert gerade ein Update"
              : "Another admin is installing an update right now"}
        </small>
      )}
      <small className="muted">
        {updateStatus?.repository ? `${updateStatus.repository} (${updateStatus.branch})` : "-"}
      </small>
      <small className="muted">
        {language === "de" ? "Aktuell" : "Current"}: {currentReleaseLabel}
      </small>
      <small className="muted">
        {language === "de" ? "Neueste Version" : "Latest"}: {latestLabel}
      </small>
      <small className="muted">
        {language === "de" ? "Ergebnis" : "Result"}: {statusLabel}
      </small>
      <small className="muted">
        {language === "de"
          ? "Sicherheitsablauf: Snapshot + Migrations-Preflight vor echter DB-Migration."
          : "Safety flow: snapshot + migration preflight before real DB migration."}
      </small>
      {updateStatus?.message && <small className="muted">{updateStatus.message}</small>}
      {updateStatus?.latest_url && (
        <a href={updateStatus.latest_url} target="_blank" rel="noreferrer">
          {language === "de" ? "Release auf GitHub öffnen" : "Open release on GitHub"}
        </a>
      )}
      <div className="row wrap">
        <button
          type="button"
          disabled={updateStatusLoading || updateInstallRunning}
          onClick={() => void loadUpdateStatus(true)}
        >
          {updateStatusLoading
            ? language === "de"
              ? "Prüfe..."
              : "Checking..."
            : language === "de"
              ? "Jetzt prüfen"
              : "Check now"}
        </button>
        <button
          type="button"
          disabled={updateInstallRunning}
          onClick={() => void installSystemUpdate(true)}
        >
          {updateInstallRunning
            ? language === "de"
              ? "Läuft..."
              : "Running..."
            : language === "de"
              ? "Dry run"
              : "Dry run"}
        </button>
        <button
          type="button"
          disabled={!updateStatus?.install_supported || updateInstallRunning}
          onClick={() => void installSystemUpdate(false)}
        >
          {updateInstallRunning
            ? language === "de"
              ? "Installiere..."
              : "Installing..."
            : language === "de"
              ? "Update installieren"
              : "Install update"}
        </button>
      </div>
      {updateProgress && (
        <div className="admin-update-progress">
          <small className="muted">
            <b>{language === "de" ? "Job-Status" : "Job status"}:</b>{" "}
            {progressStatusLabel ?? updateProgress.status}
            {updateProgress.exit_code !== null && updateProgress.exit_code !== undefined ? (
              <> · {language === "de" ? "Exit-Code" : "exit code"} {updateProgress.exit_code}</>
            ) : null}
          </small>
          {updateProgress.detail && <small className="muted">{updateProgress.detail}</small>}
          {updateProgress.log_tail ? (
            <pre
              className="admin-update-log-tail"
              style={{
                maxHeight: 220,
                overflow: "auto",
                background: "var(--surface-2, #111)",
                color: "var(--text-on-surface-2, #ddd)",
                padding: "8px 12px",
                borderRadius: 6,
                fontSize: 12,
                lineHeight: 1.4,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {updateProgress.log_tail}
            </pre>
          ) : (
            <small className="muted">
              {language === "de"
                ? "Noch keine Log-Ausgabe verfügbar."
                : "No log output yet."}
            </small>
          )}
          {isTerminalProgress && (
            <button
              type="button"
              onClick={() => setUpdateProgress(null)}
              className="ghost"
            >
              {language === "de" ? "Anzeige schließen" : "Dismiss"}
            </button>
          )}
        </div>
      )}
      {!updateStatus?.install_supported && updateStatus?.install_steps?.length ? (
        <>
          <small className="muted">
            {language === "de"
              ? "Automatische Installation ist hier nicht verfügbar. Manuelle Schritte:"
              : "Automatic install is not available here. Manual steps:"}
          </small>
          <ul className="admin-update-step-list">
            {updateStatus.install_steps.map((step) => (
              <li key={`update-step-${step}`}>
                <code>{step}</code>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
