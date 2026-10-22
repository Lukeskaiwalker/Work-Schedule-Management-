import { useAppContext } from "../context/AppContext";
import { DashboardHost } from "../components/dashboard/DashboardHost";

/**
 * „Übersicht“: the personal start page (docs/DASHBOARD.md). Everything it
 * shows — layouts per device, widgets, edit mode — lives in DashboardHost;
 * the page only keeps the self-gate every page has.
 */
export function OverviewPage() {
  const { mainView } = useAppContext();

  if (mainView !== "overview") return null;

  return <DashboardHost />;
}
