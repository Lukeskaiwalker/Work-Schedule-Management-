import { ChangeEvent, useEffect, useMemo, useState } from "react";

import { useAppContext } from "../../context/AppContext";
import type { BackupFile, BackupJobProgress } from "../../types";


function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const decimals = unitIndex >= 2 ? 2 : 0;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}


function formatTimestamp(iso: string, language: "de" | "en"): string {
  try {
    const date = new Date(iso);
    return date.toLocaleString(language === "de" ? "de-DE" : "en-US");
  } catch {
    return iso;
  }
}


/** Small banner mirroring the AdminUpdateMenu progress card. Used for both
 *  backup and restore jobs since they share the runner's job shape. */
function BackupJobBanner({
  progress,
  language,
  onDismiss,
}: {
  progress: BackupJobProgress;
  language: "de" | "en";
  onDismiss: () => void;
}) {
  const isTerminal = progress.status === "succeeded" || progress.status === "failed";
  const isRestore = progress.kind === "restore";
  const statusLabel = (() => {
    const map: Record<string, { de: string; en: string }> = {
      queued: { de: "In Warteschlange", en: "Queued" },
      running: { de: "Läuft...", en: "Running..." },
      succeeded: { de: "Erfolgreich", en: "Succeeded" },
      failed: { de: "Fehlgeschlagen", en: "Failed" },
    };
    const entry = map[progress.status];
    return entry ? entry[language] : progress.status;
  })();
  const titlePrefix = isRestore
    ? language === "de" ? "Wiederherstellung" : "Restore"
    : language === "de" ? "Backup" : "Backup";
  return (
    <div className="admin-update-progress" role="status" aria-live="polite">
      {!isTerminal && isRestore && (
        <div className="admin-system-warning">
          <span className="admin-system-warning-icon" aria-hidden="true">⚠</span>
          <span>
            {language === "de"
              ? "Wartungsmodus: Stack wird neu gestartet. Bitte nicht navigieren oder Aktionen ausführen."
              : "Maintenance mode: stack is restarting. Avoid navigation or other actions."}
          </span>
        </div>
      )}
      <small className="muted">
        <b>
          {titlePrefix} — {language === "de" ? "Job-Status" : "Job status"}:
        </b>{" "}
        {statusLabel}
        {progress.exit_code !== null && progress.exit_code !== undefined ? (
          <> · {language === "de" ? "Exit-Code" : "exit code"} {progress.exit_code}</>
        ) : null}
      </small>
      {progress.detail && <small className="muted">{progress.detail}</small>}
      {progress.log_tail ? (
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
          {progress.log_tail}
        </pre>
      ) : (
        <small className="muted">
          {language === "de"
            ? "Noch keine Log-Ausgabe verfügbar."
            : "No log output yet."}
        </small>
      )}
      {isTerminal && (
        <button type="button" onClick={onDismiss} className="ghost">
          {language === "de" ? "Anzeige schließen" : "Dismiss"}
        </button>
      )}
    </div>
  );
}


/** Modal asking the user to type the filename before initiating a restore.
 *  Friction proportional to consequence — this wipes the database. */
function RestoreConfirmModal({
  filename,
  language,
  onCancel,
  onConfirm,
}: {
  filename: string;
  language: "de" | "en";
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  const matches = typed.trim() === filename;
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 16,
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        style={{
          background: "var(--surface, #fff)",
          color: "var(--text, #111)",
          borderRadius: 8,
          padding: 20,
          maxWidth: 520,
          width: "100%",
          boxShadow: "0 16px 40px rgba(0,0,0,0.4)",
        }}
      >
        <h3 style={{ marginTop: 0 }}>
          {language === "de" ? "Wiederherstellung bestätigen" : "Confirm restore"}
        </h3>
        <p>
          {language === "de"
            ? "Diese Aktion ist destruktiv. Datenbank und Uploads werden ersetzt. Tippe den Dateinamen, um fortzufahren:"
            : "This action is destructive. The database and uploads will be replaced. Type the filename to continue:"}
        </p>
        <p>
          <code style={{ fontSize: 13 }}>{filename}</code>
        </p>
        <input
          type="text"
          value={typed}
          onChange={(event) => setTyped(event.currentTarget.value)}
          autoFocus
          aria-label={language === "de" ? "Dateiname zur Bestätigung" : "Filename to confirm"}
          style={{ width: "100%", padding: 8, fontSize: 14, marginBottom: 12 }}
        />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="ghost" onClick={onCancel}>
            {language === "de" ? "Abbrechen" : "Cancel"}
          </button>
          <button
            type="button"
            disabled={!matches}
            onClick={onConfirm}
            style={{
              background: matches ? "var(--danger, #b00020)" : undefined,
              color: matches ? "#fff" : undefined,
            }}
          >
            {language === "de" ? "Wiederherstellen" : "Restore"}
          </button>
        </div>
      </div>
    </div>
  );
}


export function AdminBackupsPanel() {
  const {
    language,
    canManageBackups,
    canExportBackups,
    canRestoreBackups,
    backupsList,
    backupsListLoading,
    backupJobProgress,
    backupJobRunning,
    setBackupJobProgress,
    loadBackupsList,
    startFullBackup,
    startRestoreFromBackup,
    downloadBackup,
    uploadBackup,
    deleteBackup,
  } = useAppContext();

  const canManage = canManageBackups;
  const canExport = canExportBackups;
  const canRestore = canRestoreBackups;
  const lang: "de" | "en" = language === "de" ? "de" : "en";

  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [creatingBackup, setCreatingBackup] = useState(false);

  // Auto-load on first render. Cached afterwards — explicit refresh button
  // forces a re-fetch when the operator wants up-to-date sizing.
  useEffect(() => {
    if (!canManage) return;
    if (backupsList !== null) return;
    if (backupsListLoading) return;
    void loadBackupsList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage]);

  const files: BackupFile[] = useMemo(
    () => backupsList?.files ?? [],
    [backupsList],
  );
  const passphraseConfigured = backupsList?.passphrase_configured ?? null;
  const freeBytes = backupsList?.free_bytes ?? 0;
  const totalBytes = backupsList?.total_bytes ?? 0;

  if (!canManage) {
    return null;
  }

  const onPickUploadFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0] ?? null;
    setUploadFile(file);
  };

  const onSubmitUpload = async () => {
    if (!uploadFile) return;
    setUploading(true);
    try {
      await uploadBackup(uploadFile);
      setUploadFile(null);
    } finally {
      setUploading(false);
    }
  };

  const onCreateBackup = async () => {
    setCreatingBackup(true);
    try {
      await startFullBackup();
    } finally {
      setCreatingBackup(false);
    }
  };

  const onConfirmRestore = async () => {
    if (!restoreTarget) return;
    const target = restoreTarget;
    setRestoreTarget(null);
    await startRestoreFromBackup(target);
  };

  const onDelete = async (filename: string) => {
    const confirmed = window.confirm(
      lang === "de"
        ? `Backup wirklich löschen?\n\n${filename}`
        : `Delete this backup?\n\n${filename}`,
    );
    if (!confirmed) return;
    await deleteBackup(filename);
  };

  return (
    <div className="admin-page-card admin-system-block">
      <h2 className="admin-page-card-title">
        {lang === "de" ? "Backup-Verwaltung" : "Backup management"}
      </h2>
      <p className="admin-tools-desc">
        {lang === "de"
          ? "Verschlüsselte Vollbackups (DB + Uploads + Manifest) erzeugen, herunterladen, hochladen oder wiederherstellen. Backups verwenden die system-weite BACKUP_PASSPHRASE — separat sicher aufbewahren."
          : "Create, download, upload, or restore encrypted full backups (DB + uploads + manifest). Backups use the system-wide BACKUP_PASSPHRASE — store it safely off-site."}
      </p>

      {passphraseConfigured === false && (
        <div className="admin-system-warning">
          <span className="admin-system-warning-icon" aria-hidden="true">⚠</span>
          <span>
            {lang === "de"
              ? "BACKUP_PASSPHRASE ist nicht gesetzt — Backup und Wiederherstellung werden fehlschlagen, bis ein Wert konfiguriert ist."
              : "BACKUP_PASSPHRASE is not set — backups and restores will fail until a value is configured."}
          </span>
        </div>
      )}

      <div className="row wrap" style={{ gap: 8, marginBottom: 8 }}>
        <button
          type="button"
          disabled={creatingBackup || backupJobRunning}
          onClick={() => void onCreateBackup()}
        >
          {creatingBackup || (backupJobRunning && backupJobProgress?.kind === "backup")
            ? lang === "de" ? "Backup läuft…" : "Backup running…"
            : lang === "de" ? "Vollbackup jetzt starten" : "Create full backup now"}
        </button>
        <button
          type="button"
          className="ghost"
          disabled={backupsListLoading}
          onClick={() => void loadBackupsList()}
        >
          {backupsListLoading
            ? lang === "de" ? "Lade…" : "Loading…"
            : lang === "de" ? "Liste aktualisieren" : "Refresh list"}
        </button>
      </div>

      <small className="muted">
        {lang === "de" ? "Speicherplatz" : "Disk usage"}: {formatBytes(totalBytes - freeBytes)}{" "}
        / {formatBytes(totalBytes)}{" "}
        ({lang === "de" ? "frei" : "free"}: {formatBytes(freeBytes)})
      </small>

      {backupJobProgress && (
        <BackupJobBanner
          progress={backupJobProgress}
          language={lang}
          onDismiss={() => setBackupJobProgress(null)}
        />
      )}

      <table className="admin-table" style={{ width: "100%", marginTop: 12 }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>
              {lang === "de" ? "Datei" : "Filename"}
            </th>
            <th style={{ textAlign: "right" }}>
              {lang === "de" ? "Größe" : "Size"}
            </th>
            <th style={{ textAlign: "left" }}>
              {lang === "de" ? "Erstellt" : "Created"}
            </th>
            <th style={{ textAlign: "left" }}>
              {lang === "de" ? "Quelle" : "Source"}
            </th>
            <th style={{ textAlign: "right" }}>
              {lang === "de" ? "Aktionen" : "Actions"}
            </th>
          </tr>
        </thead>
        <tbody>
          {files.length === 0 && !backupsListLoading && (
            <tr>
              <td colSpan={5} style={{ padding: 16, textAlign: "center", color: "var(--muted, #888)" }}>
                {lang === "de"
                  ? "Noch keine Backups vorhanden."
                  : "No backups yet."}
              </td>
            </tr>
          )}
          {files.map((file) => (
            <tr key={file.filename}>
              <td>
                <code style={{ fontSize: 12 }}>{file.filename}</code>
              </td>
              <td style={{ textAlign: "right" }}>{formatBytes(file.size_bytes)}</td>
              <td>{formatTimestamp(file.created_at, lang)}</td>
              <td>
                {file.is_generated
                  ? lang === "de" ? "Generiert" : "Generated"
                  : lang === "de" ? "Hochgeladen" : "Imported"}
              </td>
              <td style={{ textAlign: "right" }}>
                <div className="row wrap" style={{ gap: 4, justifyContent: "flex-end" }}>
                  {canExport && (
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => void downloadBackup(file.filename)}
                    >
                      {lang === "de" ? "Herunterladen" : "Download"}
                    </button>
                  )}
                  {canRestore && (
                    <button
                      type="button"
                      disabled={backupJobRunning}
                      onClick={() => setRestoreTarget(file.filename)}
                      style={{
                        background: backupJobRunning ? undefined : "var(--danger-bg, #fee)",
                        color: backupJobRunning ? undefined : "var(--danger, #b00020)",
                        borderColor: "var(--danger, #b00020)",
                      }}
                    >
                      {lang === "de" ? "Wiederherstellen" : "Restore"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void onDelete(file.filename)}
                  >
                    {lang === "de" ? "Löschen" : "Delete"}
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {canRestore && (
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--border, #ddd)" }}>
          <h3 style={{ margin: "0 0 8px" }}>
            {lang === "de" ? "Backup hochladen" : "Upload backup"}
          </h3>
          <p className="admin-tools-desc">
            {lang === "de"
              ? "Lade eine extern aufbewahrte .tar.enc-Datei hoch, um sie hier wiederherstellen zu können."
              : "Upload an externally-stored .tar.enc file so it can be restored from here."}
          </p>
          <div className="row wrap" style={{ gap: 8 }}>
            <input
              type="file"
              accept=".tar.enc,application/octet-stream"
              onChange={onPickUploadFile}
              aria-label={lang === "de" ? "Backup-Datei wählen" : "Pick backup file"}
            />
            <button
              type="button"
              disabled={!uploadFile || uploading}
              onClick={() => void onSubmitUpload()}
            >
              {uploading
                ? lang === "de" ? "Lade hoch…" : "Uploading…"
                : lang === "de" ? "Hochladen" : "Upload"}
            </button>
            {uploadFile && (
              <small className="muted">
                {uploadFile.name} ({formatBytes(uploadFile.size)})
              </small>
            )}
          </div>
        </div>
      )}

      {restoreTarget && (
        <RestoreConfirmModal
          filename={restoreTarget}
          language={lang}
          onCancel={() => setRestoreTarget(null)}
          onConfirm={() => void onConfirmRestore()}
        />
      )}
    </div>
  );
}
