import { useAppContext } from "../../context/AppContext";
import { WerkstattKpiChip } from "../../components/werkstatt/WerkstattKpiChip";
import { WerkstattMovementRow } from "../../components/werkstatt/WerkstattMovementRow";
import { WerkstattReorderRow } from "../../components/werkstatt/WerkstattReorderRow";
import { WerkstattProjectGroup } from "../../components/werkstatt/WerkstattProjectGroup";
import { WerkstattMaintenanceRow } from "../../components/werkstatt/WerkstattMaintenanceRow";
import {
  MOCK_REORDER,
  MOCK_MOVEMENTS,
  MOCK_CHECKOUT_GROUPS,
  MOCK_MAINTENANCE,
} from "../../components/werkstatt/mockData";

/**
 * WerkstattDashboardPage — Werkstatt dashboard. Ported from Paper artboard
 * 7DK-0 "Werkstatt — Dashboard". This is the default tab of the Werkstatt
 * main view.
 *
 * Self-gates on `mainView === "werkstatt" && werkstattTab === "dashboard"`.
 * TODO(werkstatt): replace MOCK_* with API data once the BE endpoints land.
 */
export function WerkstattDashboardPage() {
  const { mainView, language, werkstattTab, setWerkstattTab } = useAppContext();

  if (mainView !== "werkstatt" || werkstattTab !== "dashboard") return null;

  const de = language === "de";

  return (
    <section className="werkstatt-tab-page">
      <div className="werkstatt-kpi-strip">
        <WerkstattKpiChip
          label={de ? "ARTIKEL IM BESTAND" : "ITEMS IN STOCK"}
          value="412"
          subtitle={de ? "über 38 Kategorien" : "across 38 categories"}
          tone="neutral"
        />
        <WerkstattKpiChip
          label={de ? "MINDESTBESTAND UNTERSCHRITTEN" : "BELOW MINIMUM STOCK"}
          value="14"
          subtitle={de ? "Artikel nachbestellen" : "items to reorder"}
          tone="warning"
        />
        <WerkstattKpiChip
          label={de ? "AUSGEGEBEN AUF BAUSTELLE" : "CHECKED OUT ON SITE"}
          value="27"
          subtitle={de ? "bei 9 Projekten" : "across 9 projects"}
          tone="info"
        />
        <WerkstattKpiChip
          label={de ? "NICHT VERFÜGBAR" : "UNAVAILABLE"}
          value="3"
          subtitle={de ? "Reparatur oder verloren" : "repair or lost"}
          tone="danger"
        />
      </div>

      <div className="werkstatt-content-grid">
        <div className="werkstatt-column werkstatt-column--left">
          <section className="werkstatt-card">
            <header className="werkstatt-card-head">
              <div className="werkstatt-card-title-block">
                <h3 className="werkstatt-card-title">
                  {de ? "Nachbestellen" : "Reorder"}
                </h3>
                <span className="werkstatt-card-subtitle">
                  {de
                    ? "14 Artikel unter Mindestbestand"
                    : "14 items below minimum stock"}
                </span>
              </div>
              <button type="button" className="werkstatt-card-action">
                {de ? "Bericht öffnen →" : "Open report →"}
              </button>
            </header>
            <ul className="werkstatt-reorder-list">
              {MOCK_REORDER.map((row) => (
                <WerkstattReorderRow
                  key={row.id}
                  itemName={row.item_name}
                  articleNo={row.article_no}
                  category={row.category}
                  location={row.location}
                  stockLabel={row.stock_label}
                  severity={row.severity}
                  orderLabel={de ? "Bestellen" : "Order"}
                />
              ))}
            </ul>
          </section>

          <section className="werkstatt-card">
            <header className="werkstatt-card-head">
              <div className="werkstatt-card-title-block">
                <h3 className="werkstatt-card-title">
                  {de ? "Letzte Bewegungen" : "Recent movements"}
                </h3>
                <span className="werkstatt-card-subtitle">
                  {de
                    ? "Heute · 11 Ein- und Ausgänge"
                    : "Today · 11 ins and outs"}
                </span>
              </div>
              <div
                className="werkstatt-segmented"
                role="tablist"
                aria-label={de ? "Bewegungstyp" : "Movement type"}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected="true"
                  className="werkstatt-segmented-btn werkstatt-segmented-btn--active"
                >
                  {de ? "Alle" : "All"}
                </button>
                <button type="button" role="tab" className="werkstatt-segmented-btn">
                  {de ? "Entnahmen" : "Out"}
                </button>
                <button type="button" role="tab" className="werkstatt-segmented-btn">
                  {de ? "Rückgaben" : "Returns"}
                </button>
                <button type="button" role="tab" className="werkstatt-segmented-btn">
                  {de ? "Korrekturen" : "Adjustments"}
                </button>
              </div>
            </header>
            <ul className="werkstatt-movement-list">
              {MOCK_MOVEMENTS.map((movement) => (
                <WerkstattMovementRow
                  key={movement.id}
                  kind={movement.kind}
                  title={de ? movement.title_de : movement.title_en}
                  subtitle={movement.subtitle}
                  timestamp={de ? movement.timestamp_de : movement.timestamp_en}
                />
              ))}
            </ul>
          </section>
        </div>

        <div className="werkstatt-column werkstatt-column--right">
          <section className="werkstatt-card">
            <header className="werkstatt-card-head">
              <div className="werkstatt-card-title-block">
                <h3 className="werkstatt-card-title">
                  {de ? "Auf Baustelle" : "On site"}
                </h3>
                <span className="werkstatt-card-subtitle">
                  {de
                    ? "27 Artikel bei 9 Projekten"
                    : "27 items across 9 projects"}
                </span>
              </div>
              <button
                type="button"
                className="werkstatt-card-action"
                onClick={() => setWerkstattTab("on_site")}
              >
                {de ? "Alle →" : "All →"}
              </button>
            </header>
            <div className="werkstatt-checkout-groups">
              {MOCK_CHECKOUT_GROUPS.map((group) => (
                <WerkstattProjectGroup
                  key={group.id}
                  projectNumber={group.project_number}
                  projectTitle={group.project_title}
                  itemsLabel={
                    de
                      ? `${group.item_count} Artikel`
                      : `${group.item_count} items`
                  }
                  items={group.items}
                />
              ))}
            </div>
          </section>

          <section className="werkstatt-card">
            <header className="werkstatt-card-head">
              <div className="werkstatt-card-title-block">
                <h3 className="werkstatt-card-title">
                  {de ? "In Reparatur / Prüfung" : "Repair / Inspection"}
                </h3>
                <span className="werkstatt-card-subtitle">
                  {de
                    ? "3 Werkzeuge außer Betrieb"
                    : "3 tools out of service"}
                </span>
              </div>
            </header>
            <ul className="werkstatt-maintenance-list">
              {MOCK_MAINTENANCE.map((entry) => (
                <WerkstattMaintenanceRow
                  key={entry.id}
                  toolName={entry.tool_name}
                  context={de ? entry.context_de : entry.context_en}
                  badge={entry.badge}
                  badgeLabel={de ? entry.badge_label_de : entry.badge_label_en}
                />
              ))}
            </ul>
          </section>
        </div>
      </div>
    </section>
  );
}
