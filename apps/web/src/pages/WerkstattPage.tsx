import { useAppContext } from "../context/AppContext";
import { WerkstattBanner } from "../components/werkstatt/WerkstattBanner";
import { WerkstattDashboardPage } from "./werkstatt/WerkstattDashboardPage";
import { WerkstattInventarPage } from "./werkstatt/WerkstattInventarPage";
import { WerkstattKategorienPage } from "./werkstatt/WerkstattKategorienPage";
import { WerkstattLieferantenPage } from "./werkstatt/WerkstattLieferantenPage";
import { WerkstattBedarfePage } from "./werkstatt/WerkstattBedarfePage";
import { WerkstattKatalogPage } from "./werkstatt/WerkstattKatalogPage";
import { WerkstattDatanormImportPage } from "./werkstatt/WerkstattDatanormImportPage";
import { WerkstattOrdersPage } from "./werkstatt/WerkstattOrdersPage";
import { WerkstattNachbestellenPage } from "./werkstatt/WerkstattNachbestellenPage";
import { WerkstattAufBaustellePage } from "./werkstatt/WerkstattAufBaustellePage";
import { WerkstattMobileHomePage } from "./werkstatt/WerkstattMobileHomePage";
import { WerkstattMobileArtikelPage } from "./werkstatt/WerkstattMobileArtikelPage";
import { WerkstattMobileNachbestellenPage } from "./werkstatt/WerkstattMobileNachbestellenPage";
import { WerkstattMobileScanPage } from "./werkstatt/WerkstattMobileScanPage";
import { WerkstattPartnersTab } from "./werkstatt/WerkstattPartnersTab";

/**
 * WerkstattPage — the Werkstatt main view. Renders the tab banner and
 * dispatches to the page that matches `werkstattTab` in AppContext. Each
 * sub-page self-gates (on mainView + werkstattTab + viewport), so the
 * dispatch is flat and additive — analogous to how `ProjectPage` renders
 * every tab component in a fragment.
 *
 * Handles two mainView values:
 *   - "werkstatt"       → banner + desktop/tablet sub-pages + mobile variants
 *   - "werkstatt_scan"  → fullscreen mobile QR-scanner (no banner)
 *
 * Desktop sub-pages self-gate on `!isMobile`; mobile variants self-gate on
 * `isMobile`. Both are mounted; only the right one renders content.
 */
export function WerkstattPage() {
  const { mainView, language, werkstattTab } = useAppContext();

  if (mainView !== "werkstatt" && mainView !== "werkstatt_scan") return null;

  // Fullscreen scanner takes over — no banner, no other pages.
  if (mainView === "werkstatt_scan") {
    return <WerkstattMobileScanPage />;
  }

  const de = language === "de";

  // Desktop/tablet tabs without a dedicated page yet.
  //   artikel → Artikel-Detail (queued follow-up; mobile variant exists)
  const desktopPlaceholder = werkstattTab === "artikel";

  return (
    <section className="werkstatt-page">
      <WerkstattBanner />

      {/* Desktop / tablet sub-pages (each self-gates on mainView + tab). */}
      <WerkstattDashboardPage />
      <WerkstattInventarPage />
      <WerkstattBedarfePage />
      <WerkstattKatalogPage />
      <WerkstattLieferantenPage />
      <WerkstattPartnersTab />
      <WerkstattKategorienPage />
      <WerkstattDatanormImportPage />
      <WerkstattOrdersPage />
      <WerkstattNachbestellenPage />
      <WerkstattAufBaustellePage />

      {/* Mobile variants (each self-gates on isMobile + tab). */}
      <WerkstattMobileHomePage />
      <WerkstattMobileArtikelPage />
      <WerkstattMobileNachbestellenPage />

      {desktopPlaceholder && (
        <section className="werkstatt-tab-page werkstatt-desktop-only-placeholder">
          <div className="werkstatt-card werkstatt-placeholder-card">
            <h3>{de ? "In Arbeit" : "Coming soon"}</h3>
            <p className="muted">
              {de
                ? "Dieser Werkstatt-Bereich wird gerade gebaut. Auf Mobilgeräten ist er bereits nutzbar."
                : "This workshop section is under construction. Already available on mobile."}
            </p>
          </div>
        </section>
      )}
    </section>
  );
}
