import { WerkstattProjectGroup } from "../WerkstattProjectGroup";
import { WerkstattBlockState, type WerkstattBlockPhase } from "./WerkstattBlockState";
import { formatDueLabel, formatQuantity, pluralize } from "../../../utils/werkstattOverviewFormat";
import type { WerkstattOnSiteGroup } from "../../../utils/werkstattDashboardApi";

/**
 * "Auf Baustelle" — the first few sites of the real list.
 *
 * The rows come from `/werkstatt/on-site`, the same endpoint "Alle →" opens,
 * which replays the ledger and nets returns against checkouts. They used to
 * come from the dashboard's own block, which counts `checkout` rows and
 * subtracts nothing: a Bohrhammer returned on 12 March still sat on the
 * landing page in September with a red dot and "191 Tage überfällig" beside
 * it, and a workshop lead went looking for a tool that was on the shelf.
 *
 * What is left is an honest preview — a slice of the destination — so the
 * footer only has to say how much of it is not shown.
 */
export interface DashboardOnSiteCardProps {
  /** Already sliced to the preview size by the page. */
  groups: WerkstattOnSiteGroup[] | null;
  /** Sites and rows the slice left out, for the footer. */
  hiddenGroups: number;
  hiddenItems: number;
  /** Articles with stock still out — the one on-site figure the KPI payload
   *  computes from current stock rather than from historic ledger rows. */
  onSiteCount: number | null;
  phase: WerkstattBlockPhase | null;
  language: "de" | "en";
  now: Date;
  onOpenAll: () => void;
}

/** What the footer admits, in the order a reader needs it. */
function footNote(
  hiddenGroups: number,
  hiddenItems: number,
  de: boolean,
): string {
  const parts = [
    hiddenGroups > 0
      ? de
        ? pluralize(hiddenGroups, "weitere Baustelle", "weitere Baustellen")
        : pluralize(hiddenGroups, "more site", "more sites")
      : null,
    hiddenItems > 0
      ? de
        ? pluralize(hiddenItems, "weitere Position", "weitere Positionen")
        : pluralize(hiddenItems, "more line item", "more line items")
      : null,
  ].filter((part): part is string => part != null);

  if (parts.length === 0) {
    return de
      ? "Rückgaben sind abgezogen — mehr ist nicht ausgegeben."
      : "Returns are netted out — nothing else is checked out.";
  }
  return de
    ? `Rückgaben sind abgezogen. ${parts.join(" und ")} unter „Alle“.`
    : `Returns are netted out. ${parts.join(" and ")} under “All”.`;
}

export function DashboardOnSiteCard({
  groups,
  hiddenGroups,
  hiddenItems,
  onSiteCount,
  phase,
  language,
  now,
  onOpenAll,
}: DashboardOnSiteCardProps) {
  const de = language === "de";
  const rows = groups ?? [];

  const subtitle =
    onSiteCount == null
      ? de
        ? "nicht geladen"
        : "not loaded"
      : de
        ? `${pluralize(onSiteCount, "Artikel", "Artikel")} außer Haus`
        : `${pluralize(onSiteCount, "item", "items")} out of the workshop`;

  return (
    <section className="werkstatt-card">
      <header className="werkstatt-card-head">
        <div className="werkstatt-card-title-block">
          <h3 className="werkstatt-card-title">{de ? "Auf Baustelle" : "On site"}</h3>
          <span className="werkstatt-card-subtitle">{subtitle}</span>
        </div>
        <button type="button" className="werkstatt-card-action" onClick={onOpenAll}>
          {de ? "Alle →" : "All →"}
        </button>
      </header>

      {phase ? (
        <WerkstattBlockState
          phase={phase}
          language={language}
          emptyLabel={de ? "Nichts ausgegeben." : "Nothing checked out."}
        />
      ) : (
        <>
          <div className="werkstatt-checkout-groups">
            {rows.map((group) => (
              <WerkstattProjectGroup
                key={String(group.project_id ?? "none")}
                projectNumber={
                  group.project_number ?? (de ? "OHNE PROJEKT" : "NO PROJECT")
                }
                projectTitle={
                  group.project_title ??
                  (de ? "Entnahmen ohne Baustelle" : "Checkouts without a site")
                }
                itemsLabel={
                  de
                    ? pluralize(group.item_count, "Artikel", "Artikel")
                    : pluralize(group.item_count, "item", "items")
                }
                items={group.items.map((item) => ({
                  // Same identity the full list uses: one row per site, person
                  // and deadline, so two lots of one article never collide.
                  id: `${group.project_id ?? "none"}-${item.article_id}-${item.assignee_user_id ?? "none"}-${item.expected_return_at ?? "none"}`,
                  title: `${formatQuantity(item.quantity_out, item.unit)} ${item.article_name}`,
                  // An overdue row shows WHY it is red; everything else shows
                  // who has it, which is the question that actually gets asked.
                  trailing: item.is_overdue
                    ? formatDueLabel(item.expected_return_at, now, de)
                    : (item.assignee_display_name ??
                      formatDueLabel(item.expected_return_at, now, de)),
                  status: item.is_overdue ? "overdue" : "on_site",
                }))}
              />
            ))}
          </div>
          <p className="wsov-card-foot">{footNote(hiddenGroups, hiddenItems, de)}</p>
        </>
      )}
    </section>
  );
}
