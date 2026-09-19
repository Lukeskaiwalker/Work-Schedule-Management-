/**
 * One set of files, drawn the way the enclosing FileBrowser is set: folder
 * groups (collapsed by default) or a flat list while searching, or a tile
 * grid in gallery view.
 *
 * The rows a host passes are unfiltered; the search from the shell is applied
 * here so a nested set (a project inside the customer card) matches the same
 * way the top-level one does. Whatever is on screen, in the order it is on
 * screen, is the sequence a click hands to the viewer — "next" then means
 * the file below, and never one the list did not show.
 */
import { useMemo, useState } from "react";

import { useFileBrowserView } from "./fileBrowserContext";
import { FileRow, FileRowHead } from "./FileRow";
import {
  fileCountLabel,
  filterFilesByQuery,
  flattenGroups,
  folderLabel,
  groupFilesByFolder,
  isReportFolder,
} from "./folderGroups";
import { GalleryTile } from "./GalleryTile";
import { GALLERY_SIZE_PX } from "./useFileViewPrefs";
import type { StoredFile } from "../../types";

export type FileBrowserFilesProps = {
  rows: readonly StoredFile[];
  /** The clicked file and everything on screen with it, in display order. */
  onOpen: (file: StoredFile, sequence: StoredFile[]) => void;
  /** Present only when the host may delete; the rows then offer "Löschen". */
  onDelete?: (file: StoredFile) => void;
  /** Shown when there are no rows at all. */
  emptyText: string;
  /** Shown when the search matched nothing; defaults to "Keine Treffer". */
  noMatchText?: string;
  /** The column header of the list; a nested set leaves it to its parent. */
  showHead?: boolean;
};

export function FileBrowserFiles({
  rows,
  onOpen,
  onDelete,
  emptyText,
  noMatchText,
  showHead = true,
}: FileBrowserFilesProps) {
  const { viewMode, gallerySize, language, query } = useFileBrowserView();
  const de = language === "de";
  const isSearching = query.trim().length > 0;

  // Folders the user opened. Every group starts collapsed — images used to be
  // expanded by default and flooded the list — so the set holds exceptions.
  const [openFolders, setOpenFolders] = useState<ReadonlySet<string>>(() => new Set());

  const shown = useMemo(() => filterFilesByQuery(rows, query), [rows, query]);
  const groups = useMemo(() => groupFilesByFolder(shown), [shown]);

  function toggleFolder(folder: string) {
    setOpenFolders((current) => {
      const next = new Set(current);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  }

  const nothingText = isSearching ? (noMatchText ?? (de ? "Keine Treffer" : "No files found")) : emptyText;

  if (viewMode === "gallery") {
    // Flat contact sheet — the gallery's job is "see at a glance", not
    // "navigate hierarchy", so folder grouping is dropped on purpose. The
    // CSS variable feeds the auto-fill grid in styles.css.
    const sequence = shown;
    return (
      <div
        className="file-gallery"
        style={{ ["--gallery-tile-min" as string]: `${GALLERY_SIZE_PX[gallerySize]}px` }}
      >
        {sequence.map((file) => (
          <GalleryTile key={file.id} file={file} onOpen={(f) => onOpen(f, sequence)} />
        ))}
        {sequence.length === 0 && <small className="muted">{nothingText}</small>}
      </div>
    );
  }

  if (isSearching) {
    const sequence = shown;
    return (
      <div className="file-browser-list">
        {showHead && <FileRowHead language={language} />}
        {sequence.map((file) => (
          <FileRow
            key={file.id}
            file={file}
            language={language}
            onOpen={(f) => onOpen(f, sequence)}
            onDelete={onDelete}
          />
        ))}
        {sequence.length === 0 && <small className="muted">{nothingText}</small>}
      </div>
    );
  }

  const sequence = flattenGroups(groups);
  return (
    <div className="file-browser-list">
      {showHead && <FileRowHead language={language} />}
      {groups.map(({ folder, files }) => {
        const collapsed = !openFolders.has(folder);
        const report = isReportFolder(folder);
        return (
          <div key={folder} className="file-browser-group">
            <button
              type="button"
              className={`file-browser-folder${report ? " file-browser-folder--report" : ""}`}
              onClick={() => toggleFolder(folder)}
              aria-expanded={!collapsed}
            >
              <span className="file-folder-chevron">{collapsed ? "▶" : "▼"}</span>
              <span className="file-folder-name">📁 {folderLabel(folder, language)}</span>
              <span className="file-folder-count">{fileCountLabel(files.length, language)}</span>
              {report && collapsed && (
                <span className="file-folder-hint">
                  {de ? "Automatisch generiert" : "Auto-generated"}
                </span>
              )}
            </button>
            {!collapsed &&
              files.map((file) => (
                <FileRow
                  key={file.id}
                  file={file}
                  language={language}
                  onOpen={(f) => onOpen(f, sequence)}
                  onDelete={onDelete}
                />
              ))}
          </div>
        );
      })}
      {sequence.length === 0 && <small className="muted">{nothingText}</small>}
    </div>
  );
}
