import { useEffect, useMemo, useState } from "react";
import type { PartnerListItem, Task } from "../../types";
import { PartnerTradePill } from "../../components/partners/PartnerTradePill";
import { listPartnerTasks } from "../../utils/partnersApi";
import { useAppContext } from "../../context/AppContext";

type Props = {
  partner: PartnerListItem;
  onClose: () => void;
};

type TaskTab = "open" | "completed";

function formatWhen(iso: string | null, language: "de" | "en"): string {
  if (!iso) return "—";
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return "—";
  const locale = language === "de" ? "de-DE" : "en-US";
  return dt.toLocaleDateString(locale, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/**
 * Right-side slide-over showing a partner's contact info, notes, and linked
 * task lists. Kept as a dumb presentational module — it fetches linked
 * tasks on mount and offers a small tab switcher for Offen / Abgeschlossen.
 */
export function PartnerDetailOverlay({ partner, onClose }: Props) {
  const { language, token, openPartnerModal, archivePartner, unarchivePartner, projects } =
    useAppContext();
  const de = language === "de";

  const [tasks, setTasks] = useState<Task[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<TaskTab>("open");

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setLoadingTasks(true);
      setLoadError(null);
      try {
        const rows = await listPartnerTasks(token, partner.id);
        if (!cancelled) setTasks(rows);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setLoadError(message);
      } finally {
        if (!cancelled) setLoadingTasks(false);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [token, partner.id]);

  const { openTasks, completedTasks } = useMemo(() => {
    const open: Task[] = [];
    const completed: Task[] = [];
    tasks.forEach((task) => {
      const status = String(task.status ?? "").toLowerCase();
      if (status === "done" || status === "completed") {
        completed.push(task);
      } else {
        open.push(task);
      }
    });
    return { openTasks: open, completedTasks: completed };
  }, [tasks]);

  const visibleTasks = tab === "open" ? openTasks : completedTasks;
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );

  return (
    <aside className="partner-detail-overlay" role="dialog" aria-labelledby="partner-detail-title">
      <header className="partner-detail-overlay-head">
        <div className="partner-detail-overlay-title-block">
          <span className="partner-detail-overlay-eyebrow">
            {de ? "PARTNER" : "PARTNER"}
          </span>
          <h3 id="partner-detail-title" className="partner-detail-overlay-title">
            {partner.name}
          </h3>
          {partner.trade && (
            <div className="partner-detail-overlay-trade">
              <PartnerTradePill trade={partner.trade} />
            </div>
          )}
        </div>
        <button
          type="button"
          className="partner-detail-overlay-close"
          onClick={onClose}
          aria-label={de ? "Schließen" : "Close"}
          title={de ? "Schließen" : "Close"}
        >
          ×
        </button>
      </header>

      <section className="partner-detail-overlay-info">
        <dl className="partner-detail-overlay-dl">
          <div>
            <dt>{de ? "Ansprechpartner" : "Contact person"}</dt>
            <dd>{partner.contact_person ?? "—"}</dd>
          </div>
          <div>
            <dt>{de ? "E-Mail" : "Email"}</dt>
            <dd>
              {partner.email ? (
                <a href={`mailto:${partner.email}`}>{partner.email}</a>
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div>
            <dt>{de ? "Telefon" : "Phone"}</dt>
            <dd>
              {partner.phone ? (
                <a href={`tel:${partner.phone.replace(/\s+/g, "")}`}>{partner.phone}</a>
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div>
            <dt>{de ? "Adresse" : "Address"}</dt>
            <dd>{partner.address ?? "—"}</dd>
          </div>
          <div>
            <dt>{de ? "USt-ID" : "Tax ID"}</dt>
            <dd>{partner.tax_id ?? "—"}</dd>
          </div>
          <div>
            <dt>{de ? "Letzte Aktivität" : "Last activity"}</dt>
            <dd>{formatWhen(partner.last_task_activity_at, de ? "de" : "en")}</dd>
          </div>
        </dl>
        {partner.notes && (
          <p className="partner-detail-overlay-notes">{partner.notes}</p>
        )}
        <div className="partner-detail-overlay-actions">
          <button
            type="button"
            className="partner-list-action-btn"
            onClick={() => openPartnerModal({ initial: partner })}
          >
            {de ? "Bearbeiten" : "Edit"}
          </button>
          <button
            type="button"
            className="partner-list-action-btn partner-list-action-btn--ghost"
            onClick={() => {
              if (partner.archived_at) {
                void unarchivePartner(partner.id);
              } else {
                void archivePartner(partner.id);
              }
            }}
          >
            {partner.archived_at
              ? de
                ? "Wiederherstellen"
                : "Unarchive"
              : de
                ? "Archivieren"
                : "Archive"}
          </button>
        </div>
      </section>

      <section className="partner-detail-overlay-tasks">
        <div className="partner-detail-overlay-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "open"}
            className={
              tab === "open"
                ? "partner-detail-overlay-tab partner-detail-overlay-tab--active"
                : "partner-detail-overlay-tab"
            }
            onClick={() => setTab("open")}
          >
            {de ? "Offen" : "Open"} · {openTasks.length}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "completed"}
            className={
              tab === "completed"
                ? "partner-detail-overlay-tab partner-detail-overlay-tab--active"
                : "partner-detail-overlay-tab"
            }
            onClick={() => setTab("completed")}
          >
            {de ? "Abgeschlossen" : "Completed"} · {completedTasks.length}
          </button>
        </div>
        {loadingTasks && (
          <small className="muted">{de ? "Aufgaben werden geladen…" : "Loading tasks…"}</small>
        )}
        {loadError && (
          <small className="muted">
            {de ? "Aufgaben konnten nicht geladen werden" : "Could not load tasks"}: {loadError}
          </small>
        )}
        {!loadingTasks && !loadError && visibleTasks.length === 0 && (
          <small className="muted">
            {tab === "open"
              ? de
                ? "Keine offenen Aufgaben."
                : "No open tasks."
              : de
                ? "Keine abgeschlossenen Aufgaben."
                : "No completed tasks."}
          </small>
        )}
        <ul className="partner-detail-overlay-task-list">
          {visibleTasks.map((task) => {
            const project = projectById.get(task.project_id) ?? null;
            return (
              <li key={`partner-task-${task.id}`} className="partner-detail-overlay-task-row">
                <span className="partner-detail-overlay-task-title">{task.title}</span>
                <small>
                  {project ? `${project.project_number} — ${project.name}` : `#${task.project_id}`}
                  {task.due_date ? ` · ${task.due_date}` : ""}
                </small>
              </li>
            );
          })}
        </ul>
      </section>
    </aside>
  );
}
