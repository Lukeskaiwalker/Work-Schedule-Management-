/**
 * One list row: name, folder, type, upload time, and the actions.
 *
 * The name and "Vorschau" open the in-app viewer; "Download" stays a real
 * link, because that is the one thing a viewer cannot do better than the
 * browser. Deleting asks first, inline — a row is easy to hit on a tablet and
 * there is no undo on the server.
 *
 * Layout lives in styles/files.css under file-browser-row: a grid whose
 * columns may shrink to nothing, so the header never clips at the width of
 * an iPad beside the sidebar, and a two-line shape below ~760 px of card.
 */
import { useState } from "react";

import { fileDownloadUrl } from "../../utils/filePreview";
import { formatServerDateTime } from "../../utils/dates";
import { fileTypeLabel } from "./folderGroups";
import type { Language, StoredFile } from "../../types";

export function FileRowHead({ language }: { language: Language }) {
  const de = language === "de";
  return (
    <div className="file-browser-row file-browser-row--head" aria-hidden="true">
      <b>{de ? "Datei" : "File"}</b>
      <div className="file-browser-row-meta">
        <b>{de ? "Ordner" : "Folder"}</b>
        <b>{de ? "Typ" : "Type"}</b>
        <b>{de ? "Hochgeladen" : "Uploaded"}</b>
      </div>
      <b>{de ? "Aktion" : "Action"}</b>
    </div>
  );
}

export function FileRow({
  file,
  language,
  onOpen,
  onDelete,
}: {
  file: StoredFile;
  language: Language;
  onOpen: (file: StoredFile) => void;
  /** Absent when the host may not delete: the control is then not rendered. */
  onDelete?: (file: StoredFile) => void;
}) {
  const de = language === "de";
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="file-browser-row">
      <button
        type="button"
        className="linklike file-browser-row-name"
        title={file.file_name}
        onClick={() => onOpen(file)}
      >
        {file.file_name}
      </button>
      <div className="file-browser-row-meta">
        <small className="file-browser-row-folder">{file.folder || "/"}</small>
        <small className="file-browser-row-type">{fileTypeLabel(file.content_type)}</small>
        <small className="file-browser-row-date">
          {formatServerDateTime(file.created_at, language)}
        </small>
      </div>
      <div className="file-browser-row-actions">
        <button type="button" className="linklike" onClick={() => onOpen(file)}>
          {de ? "Vorschau" : "Preview"}
        </button>
        {/* `download` is what makes this save rather than open: in the app
            every /api/files link is intercepted so the bearer token can be
            attached, and without the attribute the in-app viewer was the
            destination of the download link too. */}
        <a
          href={fileDownloadUrl(file.id)}
          download={file.file_name}
          target="_blank"
          rel="noreferrer"
        >
          Download
        </a>
        {onDelete &&
          (confirming ? (
            <>
              <button
                type="button"
                className="file-delete-confirm-btn"
                onClick={() => {
                  setConfirming(false);
                  onDelete(file);
                }}
              >
                {de ? "Löschen" : "Delete"}
              </button>
              <button type="button" className="linklike" onClick={() => setConfirming(false)}>
                {de ? "Abbrechen" : "Cancel"}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="file-delete-btn linklike"
              onClick={() => setConfirming(true)}
              title={de ? "Datei löschen" : "Delete file"}
            >
              {de ? "Löschen" : "Delete"}
            </button>
          ))}
      </div>
    </div>
  );
}
