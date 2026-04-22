import type { Project } from "../../types";
import { useAppContext } from "../../context/AppContext";
import { formatServerDateTime } from "../../utils/dates";

/**
 * Small red dot indicator for critical projects, reused across list views and
 * the map popup. The native `title` attribute carries the audit tooltip
 * ("Critical since … · Set by …") so hover works without a custom tooltip.
 */
export function CriticalDot({ project }: { project: Project }) {
  const { language, userNameById } = useAppContext();
  if (!project.is_critical) return null;

  const sinceLabel = project.critical_since
    ? formatServerDateTime(project.critical_since, language)
    : "-";
  const byLabel = project.critical_set_by_user_id
    ? userNameById(project.critical_set_by_user_id)
    : "-";
  const prefix = language === "de" ? "Kritisch seit" : "Critical since";
  const byPrefix = language === "de" ? "Gesetzt von" : "Set by";

  return (
    <span
      className="project-critical-dot"
      aria-label={language === "de" ? "Kritisch markiert" : "Marked as critical"}
      title={`${prefix} ${sinceLabel} · ${byPrefix} ${byLabel}`}
    />
  );
}
