/**
 * The four totals above the "Auf Baustelle" list.
 *
 * Counted from the FULL response, not from the filtered view: narrowing to
 * "überfällig" must not make the headline "überfällig" number change, or the
 * strip stops being a summary and becomes a second copy of the filter.
 *
 * `totals` is null until the list loads. Every tile then reads "–".
 */
export interface OnSiteTotals {
  lineCount: number;
  projectCount: number;
  dueToday: number;
  overdue: number;
}

export interface OnSiteKpiStripProps {
  totals: OnSiteTotals | null;
  language: "de" | "en";
}

interface Tile {
  tone: "info" | "neutral" | "warning" | "danger";
  label_de: string;
  label_en: string;
  value: (totals: OnSiteTotals) => number;
  sub_de: string;
  sub_en: string;
}

const TILES: ReadonlyArray<Tile> = [
  {
    tone: "info",
    label_de: "AUSGEGEBEN",
    label_en: "CHECKED OUT",
    value: (totals) => totals.lineCount,
    sub_de: "Positionen",
    sub_en: "line items",
  },
  {
    tone: "neutral",
    label_de: "AUF PROJEKTEN",
    label_en: "AT PROJECTS",
    value: (totals) => totals.projectCount,
    sub_de: "Baustellen",
    sub_en: "sites",
  },
  {
    tone: "warning",
    label_de: "HEUTE ZURÜCK",
    label_en: "DUE TODAY",
    value: (totals) => totals.dueToday,
    sub_de: "Positionen",
    sub_en: "line items",
  },
  {
    tone: "danger",
    label_de: "ÜBERFÄLLIG",
    label_en: "OVERDUE",
    value: (totals) => totals.overdue,
    sub_de: "nachfragen",
    sub_en: "to chase",
  },
];

export function OnSiteKpiStrip({ totals, language }: OnSiteKpiStripProps) {
  const de = language === "de";
  return (
    <div className="werkstatt-kpi-strip werkstatt-onsite-kpi-strip">
      {TILES.map((tile) => (
        <div key={tile.label_en} className={`werkstatt-kpi werkstatt-kpi--${tile.tone}`}>
          <span className="werkstatt-kpi-label">{de ? tile.label_de : tile.label_en}</span>
          <div className="werkstatt-kpi-value-row">
            <span
              className={`werkstatt-kpi-value${totals ? "" : " wsov-kpi-unknown"}`}
            >
              {totals ? tile.value(totals) : "–"}
            </span>
            <span className="werkstatt-kpi-subtitle">
              {totals
                ? de
                  ? tile.sub_de
                  : tile.sub_en
                : de
                  ? "nicht geladen"
                  : "not loaded"}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
