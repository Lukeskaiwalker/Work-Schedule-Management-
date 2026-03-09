import type { Language, MonthWeekHours } from "../../types";
import { clamp, formatHours } from "../../utils/misc";
import { formatDayMonth, startOfWeekISO } from "../../utils/dates";

export function WorkHoursGauge({
  language,
  netHours,
  requiredHours,
  compact = false,
}: {
  language: Language;
  netHours: number;
  requiredHours: number;
  compact?: boolean;
}) {
  const required = requiredHours > 0 ? requiredHours : 8;
  const worked = Math.max(netHours, 0);
  const progressPercent = required > 0 ? (worked / required) * 100 : 0;
  const ringPercent = progressPercent >= 100 ? 100 : clamp(progressPercent, 0, 100);
  const overtimeBlend = clamp((progressPercent - 100) / 100, 0, 1);
  const overtimeColor = `rgb(${Math.round(47 + (180 - 47) * overtimeBlend)}, ${Math.round(111 + (54 - 111) * overtimeBlend)}, ${Math.round(127 + (65 - 127) * overtimeBlend)})`;
  const ringFillBackground =
    progressPercent > 100
      ? `conic-gradient(from -90deg, #2f6f7f 0%, ${overtimeColor} 100%)`
      : `conic-gradient(#2f6f7f ${ringPercent}%, #f1ece3 ${ringPercent}% 100%)`;
  const remaining = Math.max(required - worked, 0);
  const overtime = Math.max(worked - required, 0);

  return (
    <div className={compact ? "work-gauge compact" : "work-gauge"}>
      <div className="work-gauge-head">
        <b>{language === "de" ? "Tagesziel" : "Daily target"}</b>
        <span>{progressPercent.toFixed(0)}%</span>
      </div>
      <div
        className="work-gauge-ring"
        role="meter"
        aria-valuemin={0}
        aria-valuenow={progressPercent}
        aria-valuetext={`${progressPercent.toFixed(0)}%`}
        style={{ background: ringFillBackground }}
      >
        <div className="work-gauge-ring-inner">
          <strong className="work-gauge-value">{formatHours(worked)}</strong>
          <small>{language === "de" ? "heute" : "today"}</small>
        </div>
      </div>
      <div className="work-gauge-meta">
        <small>
          {language === "de" ? "Geleistet" : "Worked"}: {formatHours(worked)}
        </small>
        <small>
          {language === "de" ? "Soll" : "Required"}: {formatHours(required)}
        </small>
        <small>
          {overtime > 0
            ? `${language === "de" ? "Überstunden" : "Overtime"}: ${formatHours(overtime)}`
            : `${language === "de" ? "Rest" : "Remaining"}: ${formatHours(remaining)}`}
        </small>
      </div>
    </div>
  );
}

export function ProjectHoursGauge({
  language,
  plannedHours,
  workedHours,
}: {
  language: Language;
  plannedHours: number;
  workedHours: number;
}) {
  const planned = plannedHours > 0 ? plannedHours : 0;
  const worked = Math.max(workedHours, 0);
  const progressPercent = planned > 0 ? (worked / planned) * 100 : 0;
  const ringPercent = clamp(progressPercent, 0, 100);
  const overtimeBlend = clamp((progressPercent - 100) / 100, 0, 1);
  const overtimeColor = `rgb(${Math.round(47 + (180 - 47) * overtimeBlend)}, ${Math.round(111 + (54 - 111) * overtimeBlend)}, ${Math.round(127 + (65 - 127) * overtimeBlend)})`;
  const ringFillBackground =
    planned <= 0
      ? "conic-gradient(#f1ece3 0% 100%)"
      : progressPercent > 100
        ? `conic-gradient(from -90deg, #2f6f7f 0%, ${overtimeColor} 100%)`
        : `conic-gradient(#2f6f7f ${ringPercent}%, #f1ece3 ${ringPercent}% 100%)`;
  const remaining = planned > 0 ? Math.max(planned - worked, 0) : 0;
  const overtime = planned > 0 ? Math.max(worked - planned, 0) : 0;

  return (
    <div className="work-gauge">
      <div className="work-gauge-head">
        <b>{language === "de" ? "Projektstunden" : "Project hours"}</b>
        <span>{planned > 0 ? `${progressPercent.toFixed(0)}%` : "-"}</span>
      </div>
      <div
        className="work-gauge-ring"
        role="meter"
        aria-valuemin={0}
        aria-valuenow={progressPercent}
        aria-valuetext={planned > 0 ? `${progressPercent.toFixed(0)}%` : "not set"}
        style={{ background: ringFillBackground }}
      >
        <div className="work-gauge-ring-inner">
          <strong className="work-gauge-value">{formatHours(worked)}</strong>
          <small>{language === "de" ? "berichtet" : "reported"}</small>
        </div>
      </div>
      <div className="work-gauge-meta">
        <small>
          {language === "de" ? "Geplant" : "Planned"}: {planned > 0 ? formatHours(planned) : "-"}
        </small>
        <small>
          {language === "de" ? "Ist" : "Actual"}: {formatHours(worked)}
        </small>
        <small>
          {planned <= 0
            ? language === "de"
              ? "Keine geplanten Stunden gesetzt"
              : "No planned hours set"
            : overtime > 0
              ? `${language === "de" ? "Ueber Plan" : "Over plan"}: ${formatHours(overtime)}`
              : `${language === "de" ? "Rest" : "Remaining"}: ${formatHours(remaining)}`}
        </small>
      </div>
    </div>
  );
}

export function WeeklyHoursGauge({
  language,
  row,
}: {
  language: Language;
  row: MonthWeekHours;
}) {
  const percent = row.requiredHours > 0 ? (row.workedHours / row.requiredHours) * 100 : 0;
  const fillPercent = clamp(percent, 0, 100);
  const rangeLabel = `${formatDayMonth(row.weekStart)} - ${formatDayMonth(row.weekEnd)}`;
  return (
    <div className={row.weekStart === startOfWeekISO(new Date()) ? "weekly-hours-row current" : "weekly-hours-row"}>
      <div className="weekly-hours-head">
        <b>
          <span className="weekly-week-number">KW {row.weekNumber}</span> {rangeLabel}
        </b>
        <div className="weekly-hours-values">
          <span>{formatHours(row.workedHours)}</span>
          <span className="weekly-hours-separator">|</span>
          <span>{formatHours(row.requiredHours)}</span>
        </div>
      </div>
      <div className="weekly-hours-track" role="meter" aria-valuemin={0} aria-valuenow={percent} aria-valuetext={`${percent.toFixed(0)}%`}>
        <div className="weekly-hours-fill" style={{ width: `${fillPercent}%` }} />
      </div>
      <small className="muted">
        {language === "de" ? "Ist / Soll" : "Worked / Required"}: {percent.toFixed(0)}%
      </small>
    </div>
  );
}

export function MonthlyHoursGauge({
  language,
  workedHours,
  requiredHours,
}: {
  language: Language;
  workedHours: number;
  requiredHours: number;
}) {
  const required = requiredHours > 0 ? requiredHours : 1;
  const percent = (workedHours / required) * 100;
  const shownPercent = clamp(percent, 0, 100);
  const radius = 102;
  const arcLength = Math.PI * radius;
  const filledLength = (shownPercent / 100) * arcLength;
  return (
    <div className="monthly-gauge-wrap">
      <svg viewBox="0 0 260 160" className="monthly-gauge" role="meter" aria-valuemin={0} aria-valuenow={percent} aria-valuetext={`${percent.toFixed(0)}%`}>
        <path
          d={`M 28 132 A ${radius} ${radius} 0 0 1 232 132`}
          className="monthly-gauge-track"
          pathLength={arcLength}
          strokeDasharray={`${arcLength} ${arcLength}`}
        />
        <path
          d={`M 28 132 A ${radius} ${radius} 0 0 1 232 132`}
          className="monthly-gauge-fill"
          pathLength={arcLength}
          strokeDasharray={`${filledLength} ${arcLength}`}
        />
      </svg>
      <div className="monthly-gauge-center">
        <strong>{formatHours(workedHours)}</strong>
        <small>{formatHours(Math.max(requiredHours, 0))}</small>
      </div>
    </div>
  );
}
