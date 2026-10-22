import { useAppContext } from "../../../../context/AppContext";
import type { WerkstattTab } from "../../../../types";
import type { WerkstattDashboardKpis } from "../../../../types/werkstatt";
import { DashboardWidgetFrame } from "../../DashboardWidgetFrame";
import type { DashboardWidgetProps } from "../../widgetTypes";
import { useWerkstattDashboardResource } from "./werkstattResources";
import { frameState, showAllLabel, useWerkstattTabOpener, widgetTitle } from "./werkstattWidgetParts";

type KpiField = "below_min_count" | "on_site_count" | "unavailable_count" | "in_repair_count";
type Text = { de: string; en: string };

type KpiDef = {
  field: KpiField;
  label: Text;
  sub: Text;
  tab: WerkstattTab;
  /** Colour of a non-zero value; zero always reads neutral. */
  tone: "warn" | "danger" | null;
};

const KPI_DEFS: readonly KpiDef[] = [
  {
    field: "below_min_count",
    label: { de: "Unter Mindestbestand", en: "Below minimum" },
    sub: { de: "Artikel nachbestellen", en: "items to reorder" },
    tab: "nachbestellen",
    tone: "warn",
  },
  {
    field: "on_site_count",
    label: { de: "Auf Baustelle", en: "On site" },
    sub: { de: "Artikel außer Haus", en: "items out of the workshop" },
    tab: "on_site",
    tone: null,
  },
  {
    field: "unavailable_count",
    label: { de: "Nicht verfügbar", en: "Unavailable" },
    sub: { de: "kein Bestand verfügbar", en: "no stock available" },
    tab: "dashboard",
    tone: "danger",
  },
  {
    field: "in_repair_count",
    label: { de: "In Reparatur", en: "In repair" },
    sub: { de: "Artikel in der Reparatur", en: "items being repaired" },
    tab: "dashboard",
    tone: null,
  },
];

function KpiTile({
  def,
  kpis,
  de,
  withSub,
  onOpen,
}: {
  def: KpiDef;
  kpis: WerkstattDashboardKpis;
  de: boolean;
  withSub: boolean;
  onOpen: (() => void) | null;
}) {
  const value = kpis[def.field];
  const tone = value > 0 && def.tone ? ` dashboard-ws-kpi__value--${def.tone}` : "";
  const content = (
    <>
      <span className="dashboard-ws-kpi__label">{de ? def.label.de : def.label.en}</span>
      <span className={`dashboard-ws-kpi__value${tone}`}>{value}</span>
      {withSub ? <span className="dashboard-ws-kpi__sub">{de ? def.sub.de : def.sub.en}</span> : null}
    </>
  );
  return onOpen ? (
    <button type="button" className="dashboard-ws-kpi" onClick={onOpen}>
      {content}
    </button>
  ) : (
    <div className="dashboard-ws-kpi">{content}</div>
  );
}

/**
 * „Lager-Kennzahlen“: the Werkstatt's headline figures (docs/DASHBOARD.md
 * §1.1). Klein shows the two a workshop acts on — below minimum, out on site
 * — Mittel adds unavailable and in repair, Groß adds a line under each.
 *
 * The figures exist only once `/werkstatt/dashboard` answered: until then the
 * frame shows skeletons, after a failure the error, never a „0“ standing in
 * for a number nobody fetched. Unavailable and in-repair are independent
 * counts (stock_available <= 0 vs. stock_repair > 0), so neither is shown as
 * a part of the other.
 */
export default function WerkstattKpisWidget({ size }: DashboardWidgetProps) {
  const { language } = useAppContext();
  const de = language === "de";
  const resource = useWerkstattDashboardResource();
  const openTab = useWerkstattTabOpener();

  const kpis = resource.data?.kpis ?? null;
  const defs = size === "small" ? KPI_DEFS.slice(0, 2) : KPI_DEFS;

  return (
    <DashboardWidgetFrame
      title={widgetTitle("werkstatt_kpis", de)}
      state={frameState(resource)}
      action={openTab ? { label: showAllLabel(de), onClick: () => openTab("dashboard") } : null}
    >
      {kpis ? (
        <div className={`dashboard-ws-kpis dashboard-ws-kpis--${defs.length}`}>
          {defs.map((def) => (
            <KpiTile
              key={def.field}
              def={def}
              kpis={kpis}
              de={de}
              withSub={size === "large"}
              onOpen={openTab ? () => openTab(def.tab) : null}
            />
          ))}
        </div>
      ) : null}
    </DashboardWidgetFrame>
  );
}
