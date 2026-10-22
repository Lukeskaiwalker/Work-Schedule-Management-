import { useAppContext } from "../../../../context/AppContext";
import { useDashboardResource } from "../../../../hooks/useDashboardResource";
import type { Language } from "../../../../types";
import type { AbsenceKind } from "../../../../types/dashboard";
import { fetchAbsentToday } from "../../../../utils/dashboardApi";
import { DASHBOARD_POLL_MS } from "../../dashboardPolling";
import { DashboardWidgetFrame } from "../../DashboardWidgetFrame";
import { DASHBOARD_WIDGET_META } from "../../widgetMeta";
import type { DashboardWidgetProps } from "../../widgetTypes";
import { frameStateOf, limitRows, useFullPageLink } from "../personal/widgetShared";
import "./planning.css";

/**
 * „Wer fehlt heute“: who is not in today (docs/DASHBOARD.md §1, §4.3), from
 * the minimised `GET /api/dashboard/absent-today` — one row per person,
 * sorted by name on the server, with a generic kind. Sickness, accidents and
 * other private reasons arrive only as „Abwesend“, so nothing more than that
 * can reach a start page on a shared office screen.
 *
 * The route answers 403 without a planning or time-overview permission; the
 * frame then says „Keine Berechtigung.“ and the store stops asking.
 */
const ABSENT_TODAY_KEY = "dashboard:absent-today";

const KIND_LABELS: Readonly<Record<AbsenceKind, Record<Language, string>>> = {
  vacation: { de: "Urlaub", en: "Vacation" },
  school: { de: "Berufsschule", en: "Vocational school" },
  training: { de: "Fortbildung", en: "Training" },
  company_event: { de: "Betriebsveranstaltung", en: "Company event" },
  holiday: { de: "Feiertag", en: "Public holiday" },
  absent: { de: "Abwesend", en: "Absent" },
};

function kindLabel(kind: AbsenceKind, serverLabel: string, language: Language): string {
  // A kind this build does not know yet: the server's (German) label beats
  // an empty chip.
  return KIND_LABELS[kind]?.[language] ?? serverLabel;
}

export default function AbsentTodayWidget({ size }: DashboardWidgetProps) {
  const { language } = useAppContext();
  const resource = useDashboardResource(ABSENT_TODAY_KEY, fetchAbsentToday, { pollMs: DASHBOARD_POLL_MS.slow });
  const openPlanning = useFullPageLink("planning");

  const de = language === "de";
  const absences = resource.data?.absences ?? [];
  const { visible, more } = limitRows(absences, size);

  return (
    <DashboardWidgetFrame
      title={DASHBOARD_WIDGET_META.absent_today.title[language]}
      badge={resource.data === null ? null : absences.length}
      action={openPlanning ? { label: de ? "Alle anzeigen" : "Show all", onClick: openPlanning } : null}
      state={frameStateOf(resource)}
      isEmpty={resource.data !== null && absences.length === 0}
      emptyText={de ? "Heute fehlt niemand." : "Nobody is absent today."}
      more={openPlanning ? { count: more, onClick: openPlanning } : null}
    >
      <ul className="dw-plan-list">
        {visible.map((absence) => (
          <li key={absence.user_id} className="dw-plan-list__item">
            <div className="dw-plan-row dw-plan-row--static">
              <span className="dw-plan-row__main">
                <span className="dw-plan-row__title">{absence.user_name}</span>
              </span>
              <span className={`dw-absent__kind dw-absent__kind--${absence.type}`}>
                {kindLabel(absence.type, absence.label, language)}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </DashboardWidgetFrame>
  );
}
