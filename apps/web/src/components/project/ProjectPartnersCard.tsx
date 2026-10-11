import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { apiFetch } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import type { PartnerHoursEntry, ProjectPartnerLink } from "../../types";
import { formatPartnerHours } from "../../utils/partnerHours";
import {
  deletePartnerHours,
  listProjectPartnerHours,
  listProjectPartners,
  removeProjectPartner,
  saveProjectPartner,
} from "../../utils/partnersApi";
import { PartnerHoursList } from "../partners/PartnerHoursList";
import "../../styles/partner-portal-office.css";

/** The project folder partners may read (mirrors PARTNER_FOLDER on the server). */
export const PARTNER_PORTAL_FOLDER = "Partnerportal";

function rowMeta(row: ProjectPartnerLink): string {
  const tasks = row.task_count === 1 ? "1 Aufgabe" : `${row.task_count} Aufgaben`;
  const logins =
    row.portal_user_count === 0
      ? "noch kein Portal-Zugang"
      : row.portal_user_count === 1
        ? "1 Portal-Zugang"
        : `${row.portal_user_count} Portal-Zugänge`;
  return [
    row.partner.trade,
    row.assigned ? tasks : `über ${tasks}`,
    logins,
    row.hours_total > 0 ? `${formatPartnerHours(row.hours_total)} gemeldet` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function upsert(rows: ProjectPartnerLink[], saved: ProjectPartnerLink): ProjectPartnerLink[] {
  return rows.some((row) => row.partner_id === saved.partner_id)
    ? rows.map((row) => (row.partner_id === saved.partner_id ? saved : row))
    : [...rows, saved];
}

/**
 * "Partner" on the project overview: every subcontractor who sees this
 * project in the partner portal — the ones it was handed to (with the
 * office's note FOR them) and the ones who reach it through a task on it —
 * plus the hours they reported and the folder whose files they all read.
 *
 * Reading follows the project, changing needs projects:manage — the same
 * rule the API enforces.
 */
export function ProjectPartnersCard({ projectId }: { projectId: number }) {
  const {
    token,
    partners,
    loadPartners,
    canCreateProject,
    loadProjectFolders,
    setFileUploadFolder,
    setProjectTab,
    setFileUploadModalOpen,
  } = useAppContext();
  const [rows, setRows] = useState<ProjectPartnerLink[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [choice, setChoice] = useState<string>("");
  const [note, setNote] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editNote, setEditNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [hoursFor, setHoursFor] = useState<number | null>(null);
  const [hours, setHours] = useState<PartnerHoursEntry[] | null>(null);
  const [hoursBusyId, setHoursBusyId] = useState<number | null>(null);

  const report = (err: unknown) => setError(err instanceof Error ? err.message : String(err));

  // A slower answer for the previous project (or an older reload) must never
  // overwrite a newer one.
  const generation = useRef(0);
  const currentProject = useRef(projectId);
  currentProject.current = projectId;

  const load = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const next = await listProjectPartners(token, projectId);
      if (mine !== generation.current) return;
      setRows(next);
      setError(null);
    } catch (err) {
      if (mine !== generation.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mine === generation.current) setLoaded(true);
    }
  }, [token, projectId]);

  useEffect(() => {
    setLoaded(false);
    setAdding(false);
    setEditingId(null);
    setHoursFor(null);
    setHours(null);
    void load();
  }, [load]);

  const available = useMemo(() => {
    const taken = new Set(rows.filter((row) => row.assigned).map((row) => row.partner_id));
    return partners.filter((partner) => !partner.archived_at && !taken.has(partner.id));
  }, [partners, rows]);

  function openAdd() {
    setAdding(true);
    setChoice("");
    setNote("");
    // The shared list may hold the Werkstatt tab's last search or the
    // archived view; the picker needs every active partner.
    void loadPartners("", false, null);
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    const partnerId = Number(choice);
    if (!partnerId) return;
    setBusy(true);
    try {
      const saved = await saveProjectPartner(token, projectId, partnerId, note);
      setRows((current) => upsert(current, saved));
      setAdding(false);
      setError(null);
    } catch (err) {
      report(err);
    } finally {
      setBusy(false);
    }
  }

  async function saveNote(row: ProjectPartnerLink) {
    setBusy(true);
    try {
      // For a partner who only had tasks here, this hands the project over.
      const saved = await saveProjectPartner(token, projectId, row.partner_id, editNote);
      setRows((current) => upsert(current, saved));
      setEditingId(null);
      setError(null);
    } catch (err) {
      report(err);
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: ProjectPartnerLink) {
    if (!window.confirm(`${row.partner.name} von diesem Projekt entfernen? Das Projekt verschwindet aus dessen Partnerportal, sofern keine Aufgabe den Partner nennt.`)) return;
    setBusy(true);
    try {
      await removeProjectPartner(token, projectId, row.partner_id);
      await load(); // a partner with tasks here stays, as "über Aufgaben"
    } catch (err) {
      report(err);
    } finally {
      setBusy(false);
    }
  }

  async function toggleHours(row: ProjectPartnerLink) {
    if (hoursFor === row.partner_id) {
      setHoursFor(null);
      return;
    }
    setHoursFor(row.partner_id);
    if (hours === null) {
      const forProject = projectId;
      try {
        const rows = await listProjectPartnerHours(token, forProject);
        if (forProject === currentProject.current) setHours(rows);
      } catch (err) {
        if (forProject !== currentProject.current) return;
        setHours([]);
        report(err);
      }
    }
  }

  async function removeHours(entry: PartnerHoursEntry) {
    if (!window.confirm(`Stundenmeldung von ${entry.partner.name} entfernen? Das steht danach im Verlauf des Projekts.`)) return;
    setHoursBusyId(entry.id);
    try {
      await deletePartnerHours(token, entry.id);
      setHours(await listProjectPartnerHours(token, projectId));
      await load();
    } catch (err) {
      report(err);
    } finally {
      setHoursBusyId(null);
    }
  }

  async function uploadDocuments() {
    setBusy(true);
    try {
      await apiFetch(`/projects/${projectId}/folders`, token, {
        method: "POST",
        body: JSON.stringify({ path: PARTNER_PORTAL_FOLDER }),
      });
      await loadProjectFolders(projectId);
      setFileUploadFolder(PARTNER_PORTAL_FOLDER);
      setProjectTab("files");
      setFileUploadModalOpen(true);
    } catch (err) {
      report(err);
    } finally {
      setBusy(false);
    }
  }

  if (loaded && rows.length === 0 && !canCreateProject) return null;

  return (
    <div className="card project-partners-card">
      <div className="project-partners-head">
        <div>
          <h3 className="project-partners-title">Partner</h3>
          <span className="project-partners-sub">sehen dieses Projekt im Partnerportal</span>
        </div>
        {canCreateProject && !adding && (
          <button type="button" className="partner-list-action-btn" onClick={openAdd}>
            + Zuweisen
          </button>
        )}
      </div>

      {!loaded && <small className="muted">Partner werden geladen…</small>}
      {loaded && rows.length === 0 && !adding && (
        <small className="muted">Noch kein Partner. Partner an einzelnen Aufgaben sehen das Projekt mit diesen Aufgaben.</small>
      )}

      {rows.map((row) => (
        <div key={row.partner_id} className="project-partners-row">
          <div className="project-partners-row-head">
            <span className="project-partners-row-who">
              <span className="project-partners-name">{row.partner.name}</span>
              <span className={row.portal_user_count === 0 ? "project-partners-meta project-partners-meta--warn" : "project-partners-meta"}>
                {rowMeta(row)}
              </span>
            </span>
            {canCreateProject && row.assigned && (
              <button type="button" className="partner-list-action-btn partner-list-action-btn--ghost" disabled={busy} onClick={() => void remove(row)} aria-label={`${row.partner.name} entfernen`}>
                Entfernen
              </button>
            )}
          </div>
          {editingId === row.partner_id ? (
            <>
              <textarea value={editNote} maxLength={4000} onChange={(event) => setEditNote(event.target.value)} aria-label="Hinweis für den Partner" />
              <div className="project-partners-add">
                <button type="button" className="partner-list-action-btn" disabled={busy} onClick={() => void saveNote(row)}>
                  Speichern
                </button>
                <button type="button" className="partner-list-action-btn partner-list-action-btn--ghost" onClick={() => setEditingId(null)}>
                  Abbrechen
                </button>
              </div>
            </>
          ) : row.assigned ? (
            <>
              <span className="project-partners-note-label">HINWEIS FÜR DEN PARTNER</span>
              <p className="project-partners-note-text">{row.note || "—"}</p>
            </>
          ) : (
            <p className="project-partners-note-text project-partners-note-text--muted">
              Sieht das Projekt über seine Aufgaben hier, ohne Hinweis vom Büro.
            </p>
          )}
          {editingId !== row.partner_id && (canCreateProject || row.hours_total > 0) && (
            <div className="project-partners-add">
              {canCreateProject && (
                <button
                  type="button"
                  className="partner-list-action-btn partner-list-action-btn--ghost"
                  onClick={() => {
                    setEditingId(row.partner_id);
                    setEditNote(row.note ?? "");
                  }}
                >
                  {row.assigned ? "Hinweis bearbeiten" : "Hinweis hinzufügen"}
                </button>
              )}
              {row.hours_total > 0 && (
                <button
                  type="button"
                  className="partner-list-action-btn partner-list-action-btn--ghost"
                  aria-expanded={hoursFor === row.partner_id}
                  onClick={() => void toggleHours(row)}
                >
                  {hoursFor === row.partner_id ? "Stunden ausblenden" : "Stunden ansehen"}
                </button>
              )}
            </div>
          )}
          {hoursFor === row.partner_id && (
            hours === null ? (
              <small className="muted">Stunden werden geladen…</small>
            ) : (
              <PartnerHoursList
                entries={hours.filter((entry) => entry.partner.id === row.partner_id)}
                showPartner={false}
                showTask
                busyId={hoursBusyId}
                onDelete={canCreateProject ? (entry) => void removeHours(entry) : undefined}
              />
            )
          )}
        </div>
      ))}

      {adding && (
        <form className="project-partners-row" onSubmit={add}>
          <span className="project-partners-note-label">PARTNER ZUWEISEN</span>
          <div className="project-partners-add">
            <select value={choice} onChange={(event) => setChoice(event.target.value)} aria-label="Partner" required>
              <option value="">Partner wählen…</option>
              {available.map((partner) => (
                <option key={partner.id} value={partner.id}>
                  {partner.trade ? `${partner.name} (${partner.trade})` : partner.name}
                </option>
              ))}
            </select>
          </div>
          <textarea placeholder="Hinweis für den Partner (optional, im Portal sichtbar)" value={note} maxLength={4000} onChange={(event) => setNote(event.target.value)} aria-label="Hinweis für den Partner" />
          <div className="project-partners-add">
            <button type="submit" className="partner-list-action-btn" disabled={busy || !choice}>
              Zuweisen
            </button>
            <button type="button" className="partner-list-action-btn partner-list-action-btn--ghost" onClick={() => setAdding(false)}>
              Abbrechen
            </button>
          </div>
        </form>
      )}

      {(rows.length > 0 || canCreateProject) && (
        <div className="project-partners-docs">
          <span className="project-partners-note-label">UNTERLAGEN IM PORTAL</span>
          <p className="project-partners-note-text">
            Alles im Ordner „{PARTNER_PORTAL_FOLDER}“ dieses Projekts, auch in Unterordnern, sehen alle Partner oben im Portal.
          </p>
          {canCreateProject && (
            <button type="button" className="partner-list-action-btn" style={{ alignSelf: "flex-start" }} disabled={busy} onClick={() => void uploadDocuments()}>
              Unterlagen hochladen
            </button>
          )}
        </div>
      )}

      {error && <small className="partner-portal-access-error" role="alert">{error}</small>}
    </div>
  );
}
