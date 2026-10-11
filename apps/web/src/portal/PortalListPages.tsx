// The portal's two lists: the partner's jobs (grouped by day) and the
// projects they work on.

import { useMemo } from "react";
import { ChevronRightIcon, PinIcon } from "./PortalIcons";
import { EmptyState, GroupLabel, PortalBand, PortalTitle, Segmented, Skeletons, TaskRow, type NavTarget } from "./PortalParts";
import { listPortalProjects, listPortalTasks } from "./portalApi";
import { formatClock, formatShortDate, groupOpenTasks, localTodayIso } from "./portalDates";
import type { PortalMe, PortalProject, PortalScope, PortalTask } from "./portalTypes";
import { usePortalResource } from "./usePortalResource";

type ListProps = {
  token: string;
  me: PortalMe;
  scope: PortalScope;
  onScope: (scope: PortalScope) => void;
  onNavigate: (target: NavTarget) => void;
};

function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="pp-alert" role="alert">
      Die Liste konnte nicht geladen werden.{" "}
      <button type="button" className="pp-btn" style={{ marginTop: 8 }} onClick={onRetry}>
        Erneut versuchen
      </button>
    </div>
  );
}

function tasksSubtitle(scope: PortalScope, tasks: PortalTask[] | null, todayIso: string): string {
  if (!tasks) return scope === "open" ? "Ihre offenen Einsätze" : "Erledigt in den letzten 6 Monaten";
  if (scope === "done") return `${tasks.length} erledigt in den letzten 6 Monaten`;
  const today = groupOpenTasks(tasks, todayIso).find((group) => group.key === "today")?.tasks.length ?? 0;
  const open = `${tasks.length} offen`;
  if (today === 0) return open;
  return `${open} · heute ${today} ${today === 1 ? "Einsatz" : "Einsätze"}`;
}

export function PortalTasksPage({ token, me, scope, onScope, onNavigate, onOpenTask }: ListProps & { onOpenTask: (id: number) => void }) {
  const resource = usePortalResource(() => listPortalTasks(token, scope), `tasks:${scope}`);
  const todayIso = localTodayIso();
  const tasks = resource.data;
  const groups = useMemo(() => (tasks && scope === "open" ? groupOpenTasks(tasks, todayIso) : []), [tasks, scope, todayIso]);

  return (
    <>
      <PortalBand me={me} active="tasks" onNavigate={onNavigate}>
        <PortalTitle eyebrow={me.partner.name} title="Aufgaben" subtitle={tasksSubtitle(scope, tasks, todayIso)} />
      </PortalBand>
      <main className="pp-main">
        <div className="pp-main-inner">
          <Segmented
            label="Aufgaben filtern"
            value={scope}
            onChange={onScope}
            options={[
              { value: "open", label: "Offen", count: scope === "open" ? tasks?.length ?? null : null },
              { value: "done", label: "Erledigt", count: scope === "done" ? tasks?.length ?? null : null },
            ]}
          />
          {resource.loading && !tasks ? (
            <Skeletons count={3} />
          ) : resource.error && !tasks ? (
            <LoadError onRetry={resource.reload} />
          ) : !tasks || tasks.length === 0 ? (
            scope === "open" ? (
              <EmptyState title="Keine offenen Aufgaben" text={`Sobald ${me.company.name || "das Büro"} Ihnen eine Aufgabe zuweist, erscheint sie hier.`} />
            ) : (
              <EmptyState title="Noch nichts erledigt" text="Erledigte Aufgaben der letzten 6 Monate stehen hier." />
            )
          ) : scope === "open" ? (
            groups.map((group) => (
              <section key={group.key} className={`pp-group pp-group--${group.key}`} aria-label={group.label}>
                <GroupLabel label={group.label} hint={group.hint} />
                <div className={group.key === "overdue" ? "pp-card pp-card--overdue" : "pp-card"}>
                  {group.tasks.map((task) => (
                    <TaskRow key={task.id} task={task} todayIso={todayIso} group={group.key} onOpen={(t) => onOpenTask(t.id)} />
                  ))}
                </div>
              </section>
            ))
          ) : (
            <section className="pp-group" aria-label="Erledigt">
              <GroupLabel label="Erledigt" hint="letzte 6 Monate" />
              <div className="pp-card">
                {tasks.map((task) => (
                  <TaskRow key={task.id} task={task} todayIso={todayIso} onOpen={(t) => onOpenTask(t.id)} />
                ))}
              </div>
            </section>
          )}
        </div>
      </main>
    </>
  );
}

function projectFooter(project: PortalProject, todayIso: string): { text: string; urgent: boolean } {
  if (project.open_task_count === 0) {
    return { text: project.phase === "finished" ? "Abgeschlossen" : "Keine offenen Aufgaben", urgent: false };
  }
  const count = `${project.open_task_count} offene ${project.open_task_count === 1 ? "Aufgabe" : "Aufgaben"}`;
  if (project.overdue_task_count > 0) return { text: `${count} · ${project.overdue_task_count} überfällig`, urgent: true };
  const next = project.next_task;
  if (next?.due_date) {
    const when = next.due_date === todayIso ? `heute ${formatClock(next.start_time)}`.trim() : formatShortDate(next.due_date);
    return { text: `${count} · nächste ${when}`, urgent: false };
  }
  return { text: count, urgent: false };
}

export function PortalProjectsPage({ token, me, scope, onScope, onNavigate, onOpenProject }: ListProps & { onOpenProject: (id: number) => void }) {
  const resource = usePortalResource(() => listPortalProjects(token, scope), `projects:${scope}`);
  const projects = resource.data;
  const todayIso = localTodayIso();
  const openTasks = projects?.reduce((sum, project) => sum + project.open_task_count, 0) ?? 0;
  const subtitle = !projects
    ? null
    : scope === "open"
      ? `${projects.length} laufend · ${openTasks} offene ${openTasks === 1 ? "Aufgabe" : "Aufgaben"}`
      : `${projects.length} abgeschlossen`;

  return (
    <>
      <PortalBand me={me} active="projects" onNavigate={onNavigate}>
        <PortalTitle eyebrow={me.partner.name} title="Projekte" subtitle={subtitle} />
      </PortalBand>
      <main className="pp-main">
        <div className="pp-main-inner">
          <Segmented
            label="Projekte filtern"
            value={scope}
            onChange={onScope}
            options={[
              { value: "open", label: "Laufend", count: scope === "open" ? projects?.length ?? null : null },
              { value: "done", label: "Abgeschlossen", count: scope === "done" ? projects?.length ?? null : null },
            ]}
          />
          {resource.loading && !projects ? (
            <Skeletons count={3} />
          ) : resource.error && !projects ? (
            <LoadError onRetry={resource.reload} />
          ) : !projects || projects.length === 0 ? (
            <EmptyState
              title={scope === "open" ? "Keine laufenden Projekte" : "Keine abgeschlossenen Projekte"}
              text={scope === "open" ? "Projekte erscheinen hier, sobald Ihnen eines oder eine Aufgabe darin zugewiesen ist." : "Abgeschlossene Projekte stehen hier."}
            />
          ) : (
            projects.map((project) => {
              const footer = projectFooter(project, todayIso);
              return (
                <button key={project.id} type="button" className="pp-card pp-project-card" onClick={() => onOpenProject(project.id)}>
                  <span className="pp-project-number">{project.number}</span>
                  <span className="pp-project-name">{project.name}</span>
                  {project.address && (
                    <span className="pp-row-address">
                      <PinIcon size={14} />
                      {project.address}
                    </span>
                  )}
                  <span className="pp-project-footer">
                    <span className={footer.urgent ? "pp-project-footer-text pp-project-footer-text--urgent" : "pp-project-footer-text"}>{footer.text}</span>
                    <span className="pp-chevron">
                      <ChevronRightIcon size={20} />
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </main>
    </>
  );
}
