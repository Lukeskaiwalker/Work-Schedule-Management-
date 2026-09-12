/**
 * PlanningStatusBadge — small pill for the INTERNAL planning certainty of a
 * task (Task.planning_status). This is the planner's own answer to "is the
 * date fixed yet?", not whether the customer said yes: that is the
 * CustomerConfirmationDot next door, and not Task.status either.
 *
 *   tentative → "in Planung", amber with a dashed border (it is provisional)
 *   confirmed → "bestätigt", green
 *   null      → renders nothing
 *
 * Reuses the .tasks-page-row-badge vocabulary from MyTasksPage so the pill
 * sits at the same height as the ÜBERFÄLLIG / ERLEDIGT badges.
 */
import type { Language, PlanningStatus } from "../../types";
import { planningStatusLabel } from "../../utils/tasks";

type Props = {
  status: PlanningStatus | null | undefined;
  language: Language;
};

export function PlanningStatusBadge({ status, language }: Props) {
  if (status !== "tentative" && status !== "confirmed") return null;
  const de = language === "de";
  const title =
    status === "tentative"
      ? de
        ? "Interner Planungsstand: Termin noch nicht fix"
        : "Internal planning: date not fixed yet"
      : de
        ? "Interner Planungsstand: Termin bestätigt"
        : "Internal planning: date confirmed";
  return (
    <span
      className={`tasks-page-row-badge tasks-page-row-badge--planning tasks-page-row-badge--planning-${status}`}
      title={title}
    >
      {planningStatusLabel(status, language)}
    </span>
  );
}
