import { useAppContext } from "../../context/AppContext";
import { useIsMobileViewport } from "../../hooks/useIsMobileViewport";
import { splitCompactNameParts } from "../../utils/names";
import {
  MOCK_MOBILE_CHECKOUTS,
  MOCK_MOBILE_BELOW_MIN_COUNT,
} from "../../components/werkstatt/mockData";

/**
 * WerkstattMobileHomePage — mobile-only Werkstatt start screen, ported from
 * Paper artboard A3Y-0 ("Werkstatt — Mobile: Start").
 *
 * Self-gates on:
 *   - mainView === "werkstatt"
 *   - werkstattTab === "dashboard"
 *   - viewport < 768px (Paper mobile artboards are drawn at 390px)
 *
 * Outside those conditions the component returns null so the Desktop FE
 * dashboard renders instead. See useIsMobileViewport for the live media
 * query subscription.
 *
 * Mock data comes from components/werkstatt/mockData.ts. TODO(werkstatt):
 * replace MOCK_MOBILE_CHECKOUTS / MOCK_MOBILE_BELOW_MIN_COUNT with
 * /api/werkstatt/mobile/my-checkouts + /api/werkstatt/reorder/suggestions.
 */
export function WerkstattMobileHomePage() {
  const {
    mainView,
    werkstattTab,
    setMainView,
    setWerkstattTab,
    setActiveWerkstattArticleId,
    language,
    user,
  } = useAppContext();
  const { isMobile } = useIsMobileViewport();

  if (mainView !== "werkstatt" || werkstattTab !== "dashboard") return null;
  if (!isMobile) return null;

  const de = language === "de";
  const firstName = user ? splitCompactNameParts(user.display_name).first : "";
  const initials = (() => {
    if (!user) return "";
    const parts = splitCompactNameParts(user.display_name);
    const first = parts.first ? parts.first[0] : "";
    return `${first}${parts.lastInitial}`.toUpperCase();
  })();

  const greetingLabel = firstName
    ? de
      ? `Guten Morgen, ${firstName}`
      : `Good morning, ${firstName}`
    : de
      ? "Guten Morgen"
      : "Good morning";

  const openScanner = () => setMainView("werkstatt_scan");

  const openArticle = (articleId: number) => {
    setActiveWerkstattArticleId(articleId);
    setWerkstattTab("artikel");
  };

  const openReorder = () => setWerkstattTab("nachbestellen");

  return (
    <section
      className="werkstatt-mobile werkstatt-mobile--home"
      aria-label={de ? "Werkstatt Start" : "Werkstatt home"}
    >
      <header className="werkstatt-mobile-home-top">
        <div className="werkstatt-mobile-home-greeting">
          <span
            className="werkstatt-mobile-home-folder-icon"
            aria-hidden="true"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                d="M3.5 7.5a1.8 1.8 0 0 1 1.8-1.8h3.9l1.8 2.1h7.7a1.8 1.8 0 0 1 1.8 1.8v8.6a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8V7.5Z"
                stroke="#FFFFFF"
                strokeWidth="1.8"
              />
            </svg>
          </span>
          <div className="werkstatt-mobile-home-greeting-text">
            <span className="werkstatt-mobile-home-eyebrow">WERKSTATT</span>
            <span className="werkstatt-mobile-home-title">{greetingLabel}</span>
          </div>
          <span
            className="werkstatt-mobile-home-avatar"
            aria-hidden="true"
          >
            {initials || "–"}
          </span>
        </div>

        <button
          type="button"
          className="werkstatt-mobile-home-scan-card"
          onClick={openScanner}
        >
          <span
            className="werkstatt-mobile-home-scan-icon"
            aria-hidden="true"
          >
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
              <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" stroke="#2F70B7" strokeWidth="1.8" />
              <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" stroke="#2F70B7" strokeWidth="1.8" />
              <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" stroke="#2F70B7" strokeWidth="1.8" />
              <path d="M13.5 13.5h2v2h-2zM17.5 13.5h3v2h-3zM13.5 17.5h2v3h-2zM18.5 17.5h2v3h-2z" fill="#2F70B7" />
            </svg>
          </span>
          <span className="werkstatt-mobile-home-scan-text">
            <span className="werkstatt-mobile-home-scan-title">
              {de ? "QR-Code scannen" : "Scan QR code"}
            </span>
            <span className="werkstatt-mobile-home-scan-subtitle">
              {de
                ? "Artikel entnehmen oder zurückgeben"
                : "Check out or return an article"}
            </span>
          </span>
          <span
            className="werkstatt-mobile-home-scan-chevron"
            aria-hidden="true"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M9 6l6 6-6 6" stroke="#2F70B7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </button>
      </header>

      <div className="werkstatt-mobile-home-body">
        <label
          className="werkstatt-mobile-search"
          aria-label={de ? "Suche" : "Search"}
        >
          <span className="werkstatt-mobile-search-icon" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <circle cx="11" cy="11" r="7" stroke="#5C7895" strokeWidth="1.8" />
              <path d="m16 16 4 4" stroke="#5C7895" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </span>
          <input
            type="search"
            className="werkstatt-mobile-search-input"
            placeholder={
              de ? "Artikel oder Nummer suchen…" : "Search article or number…"
            }
          />
          <span className="werkstatt-mobile-search-filter" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M4 6.5h16M7 12h10M10 17.5h4" stroke="#5C7895" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </span>
        </label>

        <section className="werkstatt-mobile-card werkstatt-mobile-checkouts">
          <header className="werkstatt-mobile-card-head">
            <div>
              <h3 className="werkstatt-mobile-card-title">
                {de ? "Meine Entnahmen" : "My checkouts"}
              </h3>
              <span className="werkstatt-mobile-card-subtitle">
                {de
                  ? `${MOCK_MOBILE_CHECKOUTS.length} Artikel unterwegs`
                  : `${MOCK_MOBILE_CHECKOUTS.length} items out`}
              </span>
            </div>
            <span className="werkstatt-mobile-card-action">
              {de ? "Alle →" : "All →"}
            </span>
          </header>
          <ul className="werkstatt-mobile-checkouts-list">
            {MOCK_MOBILE_CHECKOUTS.map((row, idx) => {
              const overdue = row.status === "overdue";
              const sinceLabel = de ? row.since_de : row.since_en;
              const isLast = idx === MOCK_MOBILE_CHECKOUTS.length - 1;
              return (
                <li
                  key={row.id}
                  className={`werkstatt-mobile-checkout-row${
                    isLast ? " werkstatt-mobile-checkout-row--last" : ""
                  }`}
                >
                  <button
                    type="button"
                    className="werkstatt-mobile-checkout-row-main"
                    onClick={() => openArticle(row.article_id)}
                  >
                    <span
                      className="werkstatt-mobile-checkout-icon"
                      aria-hidden="true"
                    >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                        <path
                          d="M3 7l9-4 9 4v10l-9 4-9-4V7z"
                          stroke="#5C7895"
                          strokeWidth="1.6"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </span>
                    <span className="werkstatt-mobile-checkout-text">
                      <span className="werkstatt-mobile-checkout-title">
                        {row.item_name}
                      </span>
                      <span
                        className={`werkstatt-mobile-checkout-meta${
                          overdue ? " werkstatt-mobile-checkout-meta--overdue" : ""
                        }`}
                      >
                        {`${row.quantity}× · ${sinceLabel} · ${row.project_label}`}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`werkstatt-mobile-return-btn${
                      overdue ? " werkstatt-mobile-return-btn--overdue" : ""
                    }`}
                  >
                    {de ? "Zurück" : "Return"}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <button
          type="button"
          className="werkstatt-mobile-alert-pill"
          onClick={openReorder}
        >
          <span className="werkstatt-mobile-alert-icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 3 2.5 19.5h19L12 3Z"
                stroke="#9A4A06"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
              <path d="M12 10v4M12 17v.1" stroke="#9A4A06" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </span>
          <span className="werkstatt-mobile-alert-text">
            <span className="werkstatt-mobile-alert-title">
              {de
                ? `${MOCK_MOBILE_BELOW_MIN_COUNT} Artikel unter Mindestbestand`
                : `${MOCK_MOBILE_BELOW_MIN_COUNT} items below minimum stock`}
            </span>
            <span className="werkstatt-mobile-alert-subtitle">
              {de ? "Jetzt Bestellbericht öffnen" : "Open reorder report"}
            </span>
          </span>
          <span className="werkstatt-mobile-alert-chevron" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M9 6l6 6-6 6" stroke="#8B6B2C" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </button>
      </div>
    </section>
  );
}
