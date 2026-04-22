import { useMemo } from "react";
import { useAppContext } from "../../context/AppContext";
import { useIsMobileViewport } from "../../hooks/useIsMobileViewport";
import { AvailabilityBadge } from "../../components/werkstatt/AvailabilityBadge";
import {
  MOCK_MOBILE_ARTICLE_DETAIL,
  MOCK_MOBILE_CHECKOUTS,
  type MockMobileArticleDetail,
} from "../../components/werkstatt/mockData";

/**
 * WerkstattMobileArtikelPage — mobile-only article detail view, ported
 * from Paper artboard A7D-0 ("Werkstatt — Mobile: Artikel-Detail").
 *
 * Self-gates on:
 *   - mainView === "werkstatt"
 *   - werkstattTab === "artikel"
 *   - viewport < 768px
 *   - activeWerkstattArticleId !== null
 *
 * Replace MOCK_MOBILE_ARTICLE_DETAIL with GET /api/werkstatt/articles/{id}
 * once Desktop BE wires the endpoint. We fall back to the fixture when the
 * id isn't one of our mock checkouts so the screen still renders for QA.
 */
export function WerkstattMobileArtikelPage() {
  const {
    mainView,
    werkstattTab,
    setWerkstattTab,
    activeWerkstattArticleId,
    setActiveWerkstattArticleId,
    language,
  } = useAppContext();
  const { isMobile } = useIsMobileViewport();

  const article = useMemo<MockMobileArticleDetail | null>(() => {
    if (activeWerkstattArticleId == null) return null;
    // Look up a matching mock checkout to display a friendlier heading;
    // fall back to the detail fixture for unknown ids so QA can navigate.
    const match = MOCK_MOBILE_CHECKOUTS.find(
      (row) => row.article_id === activeWerkstattArticleId,
    );
    if (!match) return MOCK_MOBILE_ARTICLE_DETAIL;
    return {
      ...MOCK_MOBILE_ARTICLE_DETAIL,
      article_id: match.article_id,
      article_number: match.article_number,
      item_name: match.item_name,
    };
  }, [activeWerkstattArticleId]);

  if (mainView !== "werkstatt" || werkstattTab !== "artikel") return null;
  if (!isMobile) return null;
  if (!article) return null;

  const de = language === "de";

  const goBack = () => {
    setActiveWerkstattArticleId(null);
    setWerkstattTab("dashboard");
  };

  return (
    <section
      className="werkstatt-mobile werkstatt-mobile--artikel"
      aria-label={de ? "Artikel-Detail" : "Article detail"}
    >
      <header className="werkstatt-mobile-artikel-top">
        <button
          type="button"
          className="werkstatt-mobile-icon-btn"
          onClick={goBack}
          aria-label={de ? "Zurück" : "Back"}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path
              d="M15.5 5.5 8.5 12l7 6.5"
              stroke="#14293D"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <div className="werkstatt-mobile-artikel-topcenter">
          <span className="werkstatt-mobile-artikel-eyebrow">
            {de ? "ARTIKEL-DETAIL" : "ARTICLE DETAIL"}
          </span>
          <span className="werkstatt-mobile-artikel-topnumber">
            {article.article_number}
          </span>
        </div>
        <button
          type="button"
          className="werkstatt-mobile-icon-btn"
          aria-label={de ? "Weitere Aktionen" : "More actions"}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <circle cx="5" cy="12" r="1.5" fill="#14293D" />
            <circle cx="12" cy="12" r="1.5" fill="#14293D" />
            <circle cx="19" cy="12" r="1.5" fill="#14293D" />
          </svg>
        </button>
      </header>

      <div className="werkstatt-mobile-artikel-hero">
        <div className="werkstatt-mobile-artikel-hero-img" aria-hidden="true">
          <svg width="84" height="84" viewBox="0 0 24 24" fill="none">
            <path
              d="M3 7l9-4 9 4v10l-9 4-9-4V7z"
              stroke="#5C7895"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
            <path d="M3 7l9 4 9-4M12 11v10" stroke="#5C7895" strokeWidth="1.2" />
          </svg>
        </div>
        <div className="werkstatt-mobile-artikel-hero-badge">
          <AvailabilityBadge
            stockAvailable={article.stock_available}
            nextExpectedDeliveryAt={article.next_expected_delivery_at}
            de={de}
          />
        </div>
        <div className="werkstatt-mobile-artikel-hero-text">
          <h2 className="werkstatt-mobile-artikel-name">{article.item_name}</h2>
          <span className="werkstatt-mobile-artikel-meta">
            {`${article.category_name} · ${article.location_name.split(" · ")[1] ?? article.location_name}`}
          </span>
        </div>
      </div>

      <div className="werkstatt-mobile-artikel-body">
        <div className="werkstatt-mobile-artikel-stats">
          <div className="werkstatt-mobile-artikel-stat werkstatt-mobile-artikel-stat--lager">
            <span className="werkstatt-mobile-artikel-stat-label">
              {de ? "LAGER" : "IN STOCK"}
            </span>
            <span className="werkstatt-mobile-artikel-stat-value">
              {article.stock_available}
            </span>
          </div>
          <div className="werkstatt-mobile-artikel-stat werkstatt-mobile-artikel-stat--unterwegs">
            <span className="werkstatt-mobile-artikel-stat-label">
              {de ? "UNTERWEGS" : "OUT"}
            </span>
            <span className="werkstatt-mobile-artikel-stat-value">
              {article.stock_out}
            </span>
          </div>
          <div className="werkstatt-mobile-artikel-stat werkstatt-mobile-artikel-stat--bestand">
            <span className="werkstatt-mobile-artikel-stat-label">
              {de ? "BESTAND" : "TOTAL"}
            </span>
            <span className="werkstatt-mobile-artikel-stat-value">
              {article.stock_total}
            </span>
          </div>
        </div>

        <button
          type="button"
          className="werkstatt-mobile-artikel-location"
        >
          <span
            className="werkstatt-mobile-artikel-location-icon"
            aria-hidden="true"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7Z"
                stroke="#2F70B7"
                strokeWidth="1.7"
              />
              <circle cx="12" cy="9" r="2.3" stroke="#2F70B7" strokeWidth="1.7" />
            </svg>
          </span>
          <span className="werkstatt-mobile-artikel-location-text">
            <span className="werkstatt-mobile-artikel-location-name">
              {article.location_name}
            </span>
            <span className="werkstatt-mobile-artikel-location-address">
              {article.location_address}
            </span>
          </span>
          <span
            className="werkstatt-mobile-artikel-location-chevron"
            aria-hidden="true"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M9 6l6 6-6 6" stroke="#5C7895" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </button>

        <section className="werkstatt-mobile-artikel-movements">
          <header className="werkstatt-mobile-artikel-movements-head">
            <h3 className="werkstatt-mobile-artikel-movements-title">
              {de ? "Letzte Bewegungen" : "Recent movements"}
            </h3>
            <span className="werkstatt-mobile-artikel-movements-count">
              {de
                ? `${article.total_movements} gesamt`
                : `${article.total_movements} total`}
            </span>
          </header>
          <ul className="werkstatt-mobile-artikel-movements-list">
            {article.movements.map((mv) => (
              <li
                key={mv.id}
                className={`werkstatt-mobile-artikel-movement werkstatt-mobile-artikel-movement--${mv.kind}`}
              >
                <span
                  className="werkstatt-mobile-artikel-movement-dot"
                  aria-hidden="true"
                >
                  {mv.kind === "checkout" ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                      <path d="M5 12h14M13 6l6 6-6 6" stroke="#A4171C" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : mv.kind === "return" ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                      <path d="M19 12H5M11 18l-6-6 6-6" stroke="#0E6F45" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                      <path d="m5 12 5 5 9-10" stroke="#1E4E82" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
                <span className="werkstatt-mobile-artikel-movement-text">
                  <span className="werkstatt-mobile-artikel-movement-title">
                    {de ? mv.title_de : mv.title_en}
                  </span>
                  <span className="werkstatt-mobile-artikel-movement-subtitle">
                    {de ? mv.subtitle_de : mv.subtitle_en}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <footer className="werkstatt-mobile-artikel-footer">
        <button
          type="button"
          className="werkstatt-mobile-artikel-back"
          onClick={goBack}
          aria-label={de ? "Zurück" : "Back"}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path
              d="M19 12H5M11 18l-6-6 6-6"
              stroke="#5C7895"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          type="button"
          className="werkstatt-mobile-artikel-primary"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path
              d="M5 12h14M13 6l6 6-6 6"
              stroke="#FFFFFF"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>{de ? "Entnehmen" : "Check out"}</span>
        </button>
      </footer>
    </section>
  );
}
