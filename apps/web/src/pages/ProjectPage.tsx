import { useAppContext } from "../context/AppContext";
import { ProjectOverviewTab } from "./project/ProjectOverviewTab";
import { ProjectGanttTab } from "./project/ProjectGanttTab";
import { ProjectTasksTab } from "./project/ProjectTasksTab";
import { ProjectHoursTab } from "./project/ProjectHoursTab";
import { ProjectMaterialsTab } from "./project/ProjectMaterialsTab";
import { ProjectTicketsTab } from "./project/ProjectTicketsTab";
import { ProjectFilesTab } from "./project/ProjectFilesTab";
import { ProjectFinancesTab } from "./project/ProjectFinancesTab";

export function ProjectPage() {
  const { mainView, activeProject } = useAppContext();

  if (mainView !== "project" || !activeProject) return null;

  return (
    <>
      <ProjectOverviewTab />
      <ProjectGanttTab />
      <ProjectTasksTab />
      <ProjectHoursTab />
      <ProjectMaterialsTab />
      <ProjectTicketsTab />
      <ProjectFilesTab />
      <ProjectFinancesTab />
    </>
  );
}
