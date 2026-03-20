import { useAppContext } from "../../context/AppContext";

export function AdminUpdateMenu() {
  const {
    canManageSystem,
    language,
    currentReleaseLabel,
    updateStatus,
    updateStatusLoading,
    updateInstallRunning,
    loadUpdateStatus,
    installSystemUpdate,
  } = useAppContext();

  if (!canManageSystem) return null;

  const latestLabel =
    updateStatus?.latest_version || updateStatus?.latest_commit || (language === "de" ? "unbekannt" : "unknown");
  let statusLabel = language === "de" ? "Status unbekannt" : "Status unknown";
  if (updateStatus?.update_available === true) {
    statusLabel = language === "de" ? "Update verfügbar" : "Update available";
  } else if (updateStatus?.update_available === false) {
    statusLabel = language === "de" ? "Bereits aktuell" : "Up to date";
  }

  return (
    <div className="metric-stack admin-update-tools">
      <b>{language === "de" ? "System-Updates" : "System updates"}</b>
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
