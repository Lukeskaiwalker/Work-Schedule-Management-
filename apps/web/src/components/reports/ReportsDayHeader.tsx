import type { Language } from "../../types";
import {
  formatDayEcho,
  formatDayHeading,
  formatDayNumeric,
  type ReportAxis,
  type ReportGroup,
} from "../../utils/reportsLedger";

type Props = {
  group: ReportGroup;
  axis: ReportAxis;
  language: Language;
  today: string;
  yesterday: string;
  windowStart: string;
};

/**
 * The sticky landmark between day groups, and the page's single colour moment:
 * the "Heute" band renders its label in `--accent` with a 3px bar flush against
 * the card's inner left edge. The bar is absolutely positioned, so lane
 * registration is untouched. Nothing else in the table body is chromatic.
 *
 * Overflow groups ("Früher eingegangen", "Älteres Einsatzdatum", "Datum in der
 * Zukunft") exist so that every row in the payload lands in exactly one group
 * on both axes — the backend admits a row when *either* of its two dates falls
 * inside the window, so on either axis some rows are outside it.
 */
export function ReportsDayHeader({
  group,
  axis,
  language,
  today,
  yesterday,
  windowStart,
}: Props) {
  const de = language === "de";
  const count = group.reports.length;
  const countText = de
    ? `${count} ${count === 1 ? "Bericht" : "Berichte"}`
    : `${count} ${count === 1 ? "report" : "reports"}`;

  if (group.kind === "future") {
    return (
      <div className="reports-day-head">
        <span className="reports-day-label">
          {de ? "Datum in der Zukunft" : "Future date"}
        </span>
        <span className="reports-day-chip">{de ? "PRÜFEN" : "CHECK"}</span>
        <span className="reports-day-count">{countText}</span>
      </div>
    );
  }

  if (group.kind === "past") {
    const label =
      axis === "filed"
        ? de
          ? "Früher eingegangen"
          : "Filed earlier"
        : de
          ? "Älteres Einsatzdatum"
          : "Earlier site visit";
    return (
      <div className="reports-day-head reports-day-head--muted">
        <span className="reports-day-label">{label}</span>
        <span className="reports-day-echo">
          {de
            ? `vor dem ${formatDayNumeric(windowStart)}`
            : `before ${formatDayNumeric(windowStart)}`}
        </span>
        <span className="reports-day-count">{countText}</span>
      </div>
    );
  }

  const isToday = group.dayKey === today;
  const isRelative = isToday || group.dayKey === yesterday;

  return (
    <div
      className={
        isToday ? "reports-day-head reports-day-head--today" : "reports-day-head"
      }
    >
      <span className="reports-day-label">
        {formatDayHeading(group.dayKey, language, today, yesterday)}
      </span>
      {isRelative ? (
        <span className="reports-day-echo">{formatDayEcho(group.dayKey, language)}</span>
      ) : null}
      <span className="reports-day-count">{countText}</span>
    </div>
  );
}
