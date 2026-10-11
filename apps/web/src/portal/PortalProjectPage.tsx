// One project from the partner's side: the site, how to get in, what the
// office wants them to know, the plans in its "Partnerportal" folder, their
// own jobs in it — never anyone else's — and the hours their crew reported.

import { ApiError } from "../api/client";
import { KeyIcon, PhoneIcon, PinIcon, RouteIcon } from "./PortalIcons";
import { DocumentsSection } from "./PortalDocuments";
import { HoursSection, HoursSheet, useHoursReporting } from "./PortalHours";
import { EmptyState, GroupLabel, PortalBand, PortalTitle, Skeletons, TaskRow, accessText, mapsHref, telHref, type NavTarget } from "./PortalParts";
import { getPortalProject } from "./portalApi";
import { localTodayIso } from "./portalDates";
import type { PortalMe } from "./portalTypes";
import { usePortalResource } from "./usePortalResource";

export function PortalProjectPage({
  token,
  me,
  projectId,
  onBack,
  onNavigate,
  onOpenTask,
}: {
  token: string;
  me: PortalMe;
  projectId: number;
  onBack: () => void;
  onNavigate: (target: NavTarget) => void;
  onOpenTask: (id: number) => void;
}) {
  const resource = usePortalResource(() => getPortalProject(token, projectId), `project:${projectId}`);
  const project = resource.data;
  const todayIso = localTodayIso();
  const access = project ? accessText(project.site_access_type, project.site_access_note) : null;
  const openTasks = project?.tasks.filter((task) => task.status !== "done") ?? [];
  const doneTasks = project?.tasks.filter((task) => task.status === "done") ?? [];
  const companyName = me.company.name || "Büro";
  const hoursFlow = useHoursReporting(token, resource.reload);

  return (
    <>
      <PortalBand me={me} active="projects" onNavigate={onNavigate}>
        <PortalTitle
          back={{ label: "Projekte", onClick: onBack }}
          eyebrow={project ? `Projekt ${project.number}` : null}
          title={project?.name ?? "Projekt"}
          detail
          pills={
            project ? (
              <>
                <span className={project.phase === "running" ? "pp-pill pp-pill--done" : "pp-pill pp-pill--band"}>
                  {project.phase === "running" ? "Laufend" : "Abgeschlossen"}
                </span>
                {project.open_task_count > 0 && (
                  <span className="pp-pill pp-pill--band">
                    {project.open_task_count} {project.open_task_count === 1 ? "offene Aufgabe" : "offene Aufgaben"}
                  </span>
                )}
              </>
            ) : null
          }
        />
      </PortalBand>
      <main className="pp-main">
        <div className="pp-main-inner">
          {resource.loading && !project ? (
            <Skeletons count={3} />
          ) : !project ? (
            <div className="pp-alert" role="alert">
              {resource.error instanceof ApiError && resource.error.status === 404
                ? "Dieses Projekt ist Ihnen nicht (mehr) zugewiesen."
                : "Das Projekt konnte nicht geladen werden."}
            </div>
          ) : (
            <>
              {(project.address || access) && (
                <section className="pp-card" aria-label="Baustelle">
                  {project.address && (
                    <div className="pp-info-row">
                      <span className="pp-icon-slot"><PinIcon size={18} /></span>
                      <span className="pp-info-text">
                        <span className="pp-info-title">{project.address}</span>
                      </span>
                      <a className="pp-btn" href={mapsHref(project.address)} target="_blank" rel="noopener">
                        <RouteIcon size={16} />
                        Route
                      </a>
                    </div>
                  )}
                  {access && (
                    <div className="pp-info-row pp-info-row--access">
                      <span className="pp-icon-slot"><KeyIcon size={18} /></span>
                      <span className="pp-info-text">
                        <span className="pp-kicker">Zugang</span>
                        <span className="pp-body-text">{access}</span>
                      </span>
                    </div>
                  )}
                </section>
              )}

              {project.partner_note && (
                <section className="pp-card pp-card--padded" aria-label="Hinweis vom Büro">
                  <span className="pp-kicker">Hinweis vom Büro</span>
                  <p className="pp-body-text">{project.partner_note}</p>
                </section>
              )}

              <DocumentsSection documents={project.documents} />

              <section className="pp-group" aria-label="Ihre Aufgaben hier">
                <GroupLabel label="Ihre Aufgaben hier" hint={openTasks.length > 0 ? `${openTasks.length} offen` : undefined} />
                {openTasks.length === 0 ? (
                  <div className="pp-card">
                    <EmptyState title="Keine offenen Aufgaben" text="Sobald Ihnen hier etwas zugewiesen wird, steht es in dieser Liste." />
                  </div>
                ) : (
                  <div className="pp-card">
                    {openTasks.map((task) => (
                      <TaskRow key={task.id} task={task} todayIso={todayIso} showProject={false} onOpen={(t) => onOpenTask(t.id)} />
                    ))}
                  </div>
                )}
              </section>

              {doneTasks.length > 0 && (
                <section className="pp-group" aria-label="Erledigt">
                  <GroupLabel label="Erledigt" />
                  <div className="pp-card">
                    {doneTasks.map((task) => (
                      <TaskRow key={task.id} task={task} todayIso={todayIso} showProject={false} onOpen={(t) => onOpenTask(t.id)} />
                    ))}
                  </div>
                </section>
              )}

              <HoursSection
                entries={project.hours}
                total={project.hours_total}
                showTask
                message={hoursFlow.message}
                deletingId={hoursFlow.deletingId}
                onAdd={hoursFlow.open}
                onDelete={(entry) => void hoursFlow.remove(entry)}
              />

              {me.company.phone && (
                <div className="pp-contact">
                  <span className="pp-info-text">
                    <span className="pp-info-detail">Fragen zum Projekt?</span>
                    <span className="pp-info-title">{companyName} · {me.company.phone}</span>
                  </span>
                  <a className="pp-btn pp-btn--round" href={telHref(me.company.phone)} aria-label={`${companyName} anrufen`}>
                    <PhoneIcon size={20} />
                  </a>
                </div>
              )}
            </>
          )}
        </div>
      </main>
      {project && hoursFlow.sheetOpen && (
        <HoursSheet
          tasks={[...openTasks, ...doneTasks].map((task) => ({ id: task.id, title: task.title }))}
          busy={hoursFlow.busy}
          error={hoursFlow.error}
          onSubmit={(draft) => void hoursFlow.submit({ ...draft, project_id: project.id })}
          onCancel={hoursFlow.close}
        />
      )}
    </>
  );
}
