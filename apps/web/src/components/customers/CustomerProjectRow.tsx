import type { CustomerProjectSummary } from "../../utils/customersApi";

type Props = {
  project: CustomerProjectSummary;
  language: "de" | "en";
  onOpen: (projectId: number) => void;
};

function statusDotColor(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === "active" || normalized.includes("durchführung")) return "#6EA54F";
  if (normalized === "planning" || normalized.includes("angebot")) return "#F5B000";
  if (normalized === "on_hold" || normalized === "hold") return "#8FA2BA";
  if (normalized === "completed" || normalized === "done") return "#2F70B7";
  if (normalized === "archived") return "#9AAEC4";
  return "#2F70B7";
}

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
 * One row in the "Projekte" card on the customer detail page. Click bubbles
 * up to the parent so the page can apply `setActiveProjectId` + route to the
 * full project view.
 */
export function CustomerProjectRow({ project, language, onOpen }: Props) {
  const de = language === "de";
  return (
    <button
      type="button"
      className="customer-project-row"
      onClick={() => onOpen(project.id)}
    >
      <span className="customer-project-row-number">#{project.project_number}</span>
      <span className="customer-project-row-title">
        <span className="customer-project-row-name">{project.name}</span>
        {project.last_state && (
          <span className="customer-project-row-last">{project.last_state}</span>
        )}
      </span>
      <span className="customer-project-row-status">
        <span
          className="customer-project-row-status-dot"
          style={{ backgroundColor: statusDotColor(project.status) }}
          aria-hidden="true"
        />
        <span>{project.status}</span>
      </span>
      <span className="customer-project-row-date">
        {de ? "Aktualisiert" : "Updated"}:{" "}
        {formatWhen(project.last_updated_at ?? null, language)}
      </span>
    </button>
  );
}
