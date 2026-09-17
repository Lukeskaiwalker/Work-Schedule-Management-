import { AvailabilityBadge } from "../AvailabilityBadge";
import { unitLabel } from "../unitLabel";
import type { WerkstattArticle } from "../../../types/werkstatt";

/**
 * What the phone's article screen SHOWS, in the two pieces the layout needs:
 *
 *   MobileArtikelHero    — the full-bleed white band under the title bar. It is
 *                          a SIBLING of the padded body on purpose; inside it,
 *                          the photo picks up the body's side padding and the
 *                          band stops being full width.
 *   MobileArtikelBestand — counters, storage location and suppliers, which do
 *                          belong in the padded body.
 *
 * No state, no requests; the page owns those. Every value comes straight off
 * `WerkstattArticleOut` — nothing is derived here, because the counters are the
 * server's arithmetic over the movement ledger and a second opinion worked out
 * in the browser is how the two come to disagree.
 */

export interface MobileArtikelViewProps {
  article: WerkstattArticle;
  de: boolean;
}

export function MobileArtikelHero({ article, de }: MobileArtikelViewProps) {
  const unit = unitLabel(article.unit, de);

  return (
    <div className="werkstatt-mobile-artikel-hero">
      <div className="werkstatt-mobile-artikel-hero-img">
        {article.image_url ? (
          <img src={article.image_url} alt="" className="werkstatt-mobile-artikel-photo" />
        ) : (
          <svg width="84" height="84" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M3 7l9-4 9 4v10l-9 4-9-4V7z"
              stroke="#5C7895"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
            <path d="M3 7l9 4 9-4M12 11v10" stroke="#5C7895" strokeWidth="1.2" />
          </svg>
        )}
      </div>
      <div className="werkstatt-mobile-artikel-hero-badge">
        <AvailabilityBadge
          stockAvailable={article.stock_available}
          nextExpectedDeliveryAt={article.next_expected_delivery_at}
          unit={article.unit}
          de={de}
        />
      </div>
      <div className="werkstatt-mobile-artikel-hero-text">
        <h2 className="werkstatt-mobile-artikel-name">{article.item_name}</h2>
        <span className="werkstatt-mobile-artikel-meta">
          {[article.category_name, article.manufacturer, unit]
            .filter((part): part is string => Boolean(part))
            .join(" · ")}
        </span>
      </div>
    </div>
  );
}

/**
 * What is printed under the storage location.
 *
 * `internal_code` is the number on the sticker we put on the shelf ourselves
 * (`printArticleLabel` mints it); `ean` is the manufacturer's. Showing
 * whichever won under one neutral word "Barcode" put a number on screen that
 * did not match the label somebody was holding it against, with nothing saying
 * which was which — so each is named, and both are shown when both exist.
 */
function codeLine(article: WerkstattArticle, de: boolean): string | null {
  const shelf = article.internal_code ?? null;
  const ean = article.ean ?? null;
  const shelfLabel = de ? "Regal-Code" : "Shelf code";
  if (shelf && ean) return `${shelfLabel} ${shelf} · EAN ${ean}`;
  if (shelf) return `${shelfLabel} ${shelf}`;
  if (ean) return `EAN ${ean}`;
  return null;
}

export function MobileArtikelBestand({ article, de }: MobileArtikelViewProps) {
  const codes = codeLine(article, de);

  return (
    <>
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
          <span className="werkstatt-mobile-artikel-stat-label">{de ? "UNTERWEGS" : "OUT"}</span>
          <span className="werkstatt-mobile-artikel-stat-value">{article.stock_out}</span>
        </div>
        <div className="werkstatt-mobile-artikel-stat werkstatt-mobile-artikel-stat--bestand">
          <span className="werkstatt-mobile-artikel-stat-label">{de ? "BESTAND" : "TOTAL"}</span>
          <span className="werkstatt-mobile-artikel-stat-value">{article.stock_total}</span>
        </div>
      </div>

      {/* A div, not the button it used to be: there is no location screen on a
          phone to open, and a tappable-looking row that does nothing is what
          this whole screen was. */}
      <div className="werkstatt-mobile-artikel-location">
        <span className="werkstatt-mobile-artikel-location-icon" aria-hidden="true">
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
            {article.location_name ??
              (de ? "Kein Lagerort hinterlegt" : "No storage location set")}
          </span>
          <span className="werkstatt-mobile-artikel-location-address">
            {codes ?? (de ? "Kein Barcode hinterlegt" : "No barcode on file")}
          </span>
        </span>
      </div>

      {article.suppliers.length > 0 && (
        <section className="werkstatt-mobile-suppliers">
          <h3 className="werkstatt-mobile-suppliers-title">
            {de ? "Lieferanten" : "Suppliers"}
          </h3>
          <ul className="werkstatt-mobile-suppliers-list">
            {article.suppliers.map((link) => (
              <li key={link.id} className="werkstatt-mobile-supplier">
                <span className="werkstatt-mobile-supplier-name">
                  {link.supplier_name}
                  {link.is_preferred && (
                    <span className="werkstatt-mobile-supplier-tag">
                      {de ? "bevorzugt" : "preferred"}
                    </span>
                  )}
                </span>
                <span className="werkstatt-mobile-supplier-no">
                  {link.supplier_article_no ??
                    (de ? "keine Lieferantennummer" : "no supplier number")}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
