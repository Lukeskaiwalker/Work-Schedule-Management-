import { useAppContext } from "../../context/AppContext";
import type { WerkstattTab } from "../../types";

/**
 * WerkstattBanner — the tab banner at the top of the Werkstatt main view.
 * Mirrors the shape and interaction of ProjectBanner so the whole app reads
 * the same way: an eyebrow + title on the left and a horizontal tab nav on
 * the right.
 *
 * Tabs switch via `werkstattTab` from AppContext. Admin-only tabs
 * (Datanorm-Import, Bestellungen) are gated on `canManageWerkstatt` which
 * is stubbed for now until a real permission is introduced on the user
 * object — see WERKSTATT_CONTRACT.md §3.
 */
type TabDef = {
  key: WerkstattTab;
  label_de: string;
  label_en: string;
  adminOnly?: boolean;
};

const TAB_DEFS: ReadonlyArray<TabDef> = [
  { key: "dashboard", label_de: "Dashboard", label_en: "Dashboard" },
  { key: "inventar", label_de: "Bestand", label_en: "Stock" },
  { key: "on_site", label_de: "Auf Baustelle", label_en: "On site" },
  { key: "nachbestellen", label_de: "Nachbestellen", label_en: "Reorder" },
  { key: "bedarfe", label_de: "Projekt-Bedarfe", label_en: "Project needs" },
  { key: "katalog", label_de: "Katalog", label_en: "Catalog" },
  { key: "lieferanten", label_de: "Lieferanten", label_en: "Suppliers" },
  { key: "partner", label_de: "Partner", label_en: "Partners" },
  { key: "kategorien", label_de: "Kategorien & Lagerorte", label_en: "Categories & locations" },
  { key: "orders", label_de: "Bestellungen", label_en: "Orders", adminOnly: true },
  { key: "datanorm_import", label_de: "Datanorm-Import", label_en: "Datanorm import", adminOnly: true },
];

export function WerkstattBanner() {
  const { mainView, language, werkstattTab, setWerkstattTab, user } = useAppContext();

  if (mainView !== "werkstatt") return null;

  const de = language === "de";

  // TODO(werkstatt): swap stub for real permission once BE lands the claim.
  const canManageWerkstatt =
    user?.effective_permissions?.includes("werkstatt:manage") ?? true;

  const visibleTabs = TAB_DEFS.filter((def) => !def.adminOnly || canManageWerkstatt);

  return (
    <div className="werkstatt-banner">
      <div className="werkstatt-banner-inner">
        <div className="werkstatt-banner-info">
          <span className="werkstatt-banner-eyebrow">
            {de ? "WERKSTATT" : "WORKSHOP"}
          </span>
          <h2 className="werkstatt-banner-title">
            {de ? "Werkstatt & Inventar" : "Workshop & Inventory"}
          </h2>
        </div>
        <nav className="werkstatt-banner-tabs" aria-label={de ? "Werkstatt-Reiter" : "Workshop tabs"}>
          {visibleTabs.map((def) => (
            <button
              key={def.key}
              type="button"
              className={`werkstatt-banner-tab${werkstattTab === def.key ? " active" : ""}`}
              onClick={() => setWerkstattTab(def.key)}
            >
              {de ? def.label_de : def.label_en}
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}
