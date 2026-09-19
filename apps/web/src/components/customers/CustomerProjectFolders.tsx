/**
 * "Projektordner" on the customer files card: one collapsed folder row per
 * project of the customer. Opening one loads that project's files once and
 * shows them with the same rows and tiles as everything else — read-only
 * here except preview and download; editing a project's files is what the
 * project page is for, hence the "Im Projekt öffnen" link beside each row.
 */
import { useState } from "react";

import { apiFetch } from "../../api/client";
import { FileBrowserFiles } from "../files/FileBrowserFiles";
import { fileCountLabel } from "../files/folderGroups";
import type { CustomerProjectSummary } from "../../utils/customersApi";
import type { Language, StoredFile } from "../../types";

type ProjectFilesLoad =
  | { kind: "loading" }
  | { kind: "ready"; rows: StoredFile[] }
  | { kind: "error"; message: string };

export type CustomerProjectFoldersProps = {
  projects: readonly CustomerProjectSummary[];
  token: string | null;
  language: Language;
  /** A file of `project`, with the sequence shown beside it. */
  onOpenFile: (file: StoredFile, sequence: StoredFile[], project: CustomerProjectSummary) => void;
  onOpenProject: (projectId: number) => void;
};

export function projectFolderName(project: CustomerProjectSummary): string {
  return `${project.project_number} – ${project.name}`;
}

export function CustomerProjectFolders({
  projects,
  token,
  language,
  onOpenFile,
  onOpenProject,
}: CustomerProjectFoldersProps) {
  const de = language === "de";
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  // Per project, and kept after a collapse: opening a folder twice must not
  // fetch twice. Only a failed load is retried, explicitly.
  const [loads, setLoads] = useState<Readonly<Record<number, ProjectFilesLoad>>>({});

  async function loadProject(projectId: number) {
    setLoads((current) => ({ ...current, [projectId]: { kind: "loading" } }));
    try {
      const rows = await apiFetch<StoredFile[]>(`/projects/${projectId}/files`, token);
      setLoads((current) => ({ ...current, [projectId]: { kind: "ready", rows } }));
    } catch (err: unknown) {
      const message = err instanceof Error && err.message ? err.message : "Failed to load files";
      setLoads((current) => ({ ...current, [projectId]: { kind: "error", message } }));
    }
  }

  function toggle(projectId: number) {
    const opening = !open.has(projectId);
    setOpen((current) => {
      const next = new Set(current);
      if (opening) next.add(projectId);
      else next.delete(projectId);
      return next;
    });
    if (opening && !loads[projectId]) void loadProject(projectId);
  }

  return (
    <div className="file-browser-section">
      <h4 className="file-browser-section-title">{de ? "Projektordner" : "Project folders"}</h4>
      {projects.map((project) => {
        const expanded = open.has(project.id);
        const load = loads[project.id];
        return (
          <div key={project.id} className="file-browser-group">
            <div className="file-browser-project">
              <button
                type="button"
                className="file-browser-folder file-browser-folder--project"
                onClick={() => toggle(project.id)}
                aria-expanded={expanded}
              >
                <span className="file-folder-chevron">{expanded ? "▼" : "▶"}</span>
                <span className="file-folder-name">📁 {projectFolderName(project)}</span>
                {project.status && <span className="file-browser-chip">{project.status}</span>}
                {load?.kind === "ready" && (
                  <span className="file-folder-count">
                    {fileCountLabel(load.rows.length, language)}
                  </span>
                )}
              </button>
              <button
                type="button"
                className="linklike file-browser-project-open"
                onClick={() => onOpenProject(project.id)}
              >
                {de ? "Im Projekt öffnen" : "Open in project"}
              </button>
            </div>
            {expanded && (
              <div className="file-browser-project-body">
                {!load || load.kind === "loading" ? (
                  <small className="muted" role="status">
                    {de ? "Wird geladen…" : "Loading…"}
                  </small>
                ) : load.kind === "error" ? (
                  <div className="file-browser-status file-browser-status--error" role="alert">
                    <span>
                      {de ? "Dateien konnten nicht geladen werden." : "Files could not be loaded."}
                    </span>
                    <small className="muted">{load.message}</small>
                    <button
                      type="button"
                      className="linklike"
                      onClick={() => void loadProject(project.id)}
                    >
                      {de ? "Erneut versuchen" : "Try again"}
                    </button>
                  </div>
                ) : (
                  <FileBrowserFiles
                    rows={load.rows}
                    showHead={false}
                    onOpen={(file, sequence) => onOpenFile(file, sequence, project)}
                    emptyText={de ? "Keine Dateien im Projekt." : "No files in this project."}
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
