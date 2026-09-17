import { WerkstattReorderRow } from "../WerkstattReorderRow";
import { WerkstattBlockState, type WerkstattBlockPhase } from "./WerkstattBlockState";
import {
  formatCents,
  formatQuantity,
  pluralize,
} from "../../../utils/werkstattOverviewFormat";
import type { ReorderSuggestionLine } from "../../../utils/werkstattReorderApi";

/**
 * "Nachbestellen" — the most urgent lines the Nachbestellen page will list.
 *
 * The rows come from `/werkstatt/reorder/suggestions`, the same query that
 * backs the page every button on this card opens. They used to come from the
 * dashboard's own preview block, which selects on stock alone: an article with
 * no supplier link appeared here and then did not exist on the page its
 * "Bestellen" button led to, and the footer counted it among the "N weitere"
 * waiting there.
 *
 * The lines carry no category and no shelf location, so the two columns the
 * row component has for those show what the payload DOES contain: the
 * suggested order quantity and the unit price.
 */
export interface DashboardReorderCardProps {
  /** Already sliced to the preview length by the page. */
  lines: ReorderSuggestionLine[] | null;
  /** How many lines the Nachbestellen page lists in total. */
  orderableCount: number | null;
  /** From the KPI block: articles below their minimum, supplier link or not.
   *  The larger of the two numbers, and the honest one for the subtitle. */
  belowMinCount: number | null;
  phase: WerkstattBlockPhase | null;
  language: "de" | "en";
  onOpenReorder: () => void;
}

export function DashboardReorderCard({
  lines,
  orderableCount,
  belowMinCount,
  phase,
  language,
  onOpenReorder,
}: DashboardReorderCardProps) {
  const de = language === "de";
  const rows = lines ?? [];

  /** Lines that exist on the Nachbestellen page but not on this card. */
  const hidden =
    orderableCount != null ? Math.max(0, orderableCount - rows.length) : 0;
  /** Articles below minimum that the Nachbestellen page cannot show at all,
   *  because the suggestion engine skips anything with no supplier link. They
   *  are counted in the subtitle above, so the gap has to be named — otherwise
   *  the two numbers on one card contradict each other. */
  const unlinked =
    belowMinCount != null && orderableCount != null
      ? Math.max(0, belowMinCount - orderableCount)
      : 0;

  return (
    <section className="werkstatt-card">
      <header className="werkstatt-card-head">
        <div className="werkstatt-card-title-block">
          <h3 className="werkstatt-card-title">{de ? "Nachbestellen" : "Reorder"}</h3>
          <span className="werkstatt-card-subtitle">
            {belowMinCount == null
              ? de
                ? "Anzahl nicht geladen"
                : "count not loaded"
              : de
                ? `${pluralize(belowMinCount, "Artikel", "Artikel")} unter Mindestbestand`
                : `${pluralize(belowMinCount, "item", "items")} below minimum stock`}
          </span>
        </div>
        <button type="button" className="werkstatt-card-action" onClick={onOpenReorder}>
          {de ? "Nachbestellen öffnen →" : "Open reorder →"}
        </button>
      </header>

      {phase ? (
        <WerkstattBlockState
          phase={phase}
          language={language}
          emptyLabel={
            de
              ? "Nichts zu bestellen — alles über Mindestbestand oder ohne Lieferant."
              : "Nothing to order — everything is above minimum or has no supplier."
          }
        />
      ) : (
        <>
          <ul className="werkstatt-reorder-list">
            {rows.map((line) => {
              const price = formatCents(line.unit_price_cents, de);
              return (
                <WerkstattReorderRow
                  key={line.article_id}
                  itemName={line.article_name}
                  articleNo={line.article_number}
                  category={
                    de
                      ? `Vorschlag ${formatQuantity(line.suggested_quantity, line.unit)}`
                      : `Suggested ${formatQuantity(line.suggested_quantity, line.unit)}`
                  }
                  location={price ?? (de ? "kein Preis" : "no price")}
                  stockLabel={`${line.stock_available} / ${line.stock_min}`}
                  severity={line.stock_available <= 0 ? "out" : "low"}
                  orderLabel={de ? "Bestellen" : "Order"}
                  onOrder={onOpenReorder}
                />
              );
            })}
          </ul>
          {(hidden > 0 || unlinked > 0) && (
            <p className="wsov-card-foot">
              {hidden > 0 &&
                (de
                  ? `Vorschau der dringendsten Positionen — ${hidden} weitere unter Nachbestellen. `
                  : `Preview of the most urgent lines — ${hidden} more under Reorder. `)}
              {unlinked > 0 &&
                (de
                  ? `${pluralize(unlinked, "Artikel hat", "Artikel haben")} keinen Lieferanten hinterlegt und ${unlinked === 1 ? "erscheint" : "erscheinen"} dort nicht.`
                  : `${pluralize(unlinked, "item has", "items have")} no supplier linked and will not be listed there.`)}
            </p>
          )}
        </>
      )}
    </section>
  );
}
