import type { ReactNode } from "react";

import { useAppContext } from "../../../../context/AppContext";
import { useDashboardNavigation } from "../../../../hooks/useDashboardNavigation";
import type { Project } from "../../../../types";
import { CriticalDot } from "../../../project/CriticalDot";

/**
 * Project rows for „Meine Projekte“ and „Kritische Projekte“: number and
 * customer, the site or address underneath, opening the project on click
 * through useDashboardNavigation (which keeps the old overview's back
 * button). `aside` puts a short note on the right, e.g. „seit 20.10.“.
 */
type ProjectRowsProps = {
  projects: readonly Project[];
  /** The red dot for critical projects; pointless in a list of only critical ones. */
  showCriticalDot?: boolean;
  aside?: (project: Project) => ReactNode;
};

export function ProjectRows({ projects, showCriticalDot = false, aside }: ProjectRowsProps) {
  const { projectTitleParts } = useAppContext();
  const { open } = useDashboardNavigation();

  return (
    <ul className="dw-plan-list">
      {projects.map((project) => {
        const label = projectTitleParts(project);
        const note = aside ? aside(project) : null;
        return (
          <li key={project.id} className="dw-plan-list__item">
            <button
              type="button"
              className="dw-plan-row"
              onClick={() => open({ kind: "project", projectId: project.id })}
            >
              <span className="dw-plan-row__main">
                <span className="dw-plan-row__title">
                  {label.title}
                  {showCriticalDot ? <CriticalDot project={project} /> : null}
                </span>
                {label.subtitle ? <span className="dw-plan-row__meta">{label.subtitle}</span> : null}
              </span>
              {note ? <span className="dw-plan-row__aside">{note}</span> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
