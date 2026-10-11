/**
 * Taking an article off the shelf — the rules the desk "Entnehmen" and the
 * phone's article screen share.
 *
 * The owner's rule (2026-10-10): anything the Maschinen tab does not list is a
 * consumable, and a consumable that is taken is booked out of the inventory
 * for good — it is installed at a site. The server books it as `consumption`
 * (with the person and, when chosen, the project) and only a machine type is
 * still lent as a `checkout`. The same endpoint answers both, and says which
 * one it booked in `booked_as`.
 *
 * Pure: no React, no fetch, so the sentence a page shows after a booking is
 * testable without mounting the page.
 */
import type { Project } from "../../types";
import { inProgressRank, isArchivedProjectStatus } from "../../utils/projects";
import type { WerkstattCheckoutResult } from "../../utils/werkstattArticlesApi";

/**
 * The checkout answer — exactly what `checkoutArticle` returns, so the desk
 * and the phone hand it in as is and there is one shape to keep in step with
 * the API, not two. `booked_as` and `stock_warning` are optional there because
 * an API from before the consumable split does not send them — and such an API
 * booked a loan, which is how a missing `booked_as` is read below.
 */
export type DispenseResult = WerkstattCheckoutResult;

/** One entry of the dialog's project picker. */
export interface DispenseProjectOption {
  id: string;
  number: string;
  title: string;
}

/**
 * Upper bound of one consumption. The shelf count is no cap any more (a short
 * shelf is booked up, not refused), so the field needs a ceiling of its own;
 * the Regal station's endpoint takes the same.
 */
export const CONSUMPTION_MAX_QUANTITY = 10_000;

/**
 * Consumable = not a machine type. A caller that does not say counts as a
 * consumable: the Bestand page lists `kind=consumable` only, and the server
 * decides in the end anyway (`booked_as`).
 */
export function isConsumableArticle(article: { is_serialized?: boolean | null }): boolean {
  return article.is_serialized !== true;
}

/**
 * The projects a consumption may be booked onto, running jobs first.
 *
 * Archived projects are left out: the server refuses them ("Projekt nicht
 * verfügbar."), and a picker offering what will be refused is a trap. The sort
 * is stable, so the context's own order survives inside each group.
 */
export function dispenseProjectOptions(
  projects: ReadonlyArray<Pick<Project, "id" | "project_number" | "name" | "status">>,
): DispenseProjectOption[] {
  return projects
    .filter((project) => !isArchivedProjectStatus(project.status))
    .map((project, index) => ({ project, index }))
    .sort(
      (a, b) =>
        inProgressRank(a.project.status) - inProgressRank(b.project.status) || a.index - b.index,
    )
    .map(({ project }) => ({
      id: String(project.id),
      number: project.project_number,
      title: project.name,
    }));
}

function projectText(project: DispenseProjectOption): string {
  return [project.number, project.title].filter((part) => part.trim() !== "").join(" ");
}

/**
 * What the page says after a booking.
 *
 * Follows `booked_as` — what the server DID — rather than what the dialog
 * assumed, and quotes the counters the server answered with. A consumption
 * names its project (or says there was none) and carries the server's stock
 * warning verbatim, because that warning is the only sign the shelf count was
 * wrong and needs counting.
 */
export function dispenseNotice(
  input: {
    result: DispenseResult;
    quantity: number;
    itemName: string;
    project: DispenseProjectOption | null;
  },
  de: boolean,
): string {
  const { result, quantity, itemName, project } = input;
  const totals = de
    ? `${result.stock_available} von ${result.stock_total} noch verfügbar`
    : `${result.stock_available} of ${result.stock_total} still available`;

  if (result.booked_as !== "consumption") {
    return de
      ? `${quantity}× ${itemName} entnommen — ${totals}`
      : `Checked out ${quantity}× ${itemName} — ${totals}`;
  }

  const target = project
    ? de
      ? `verbraucht für ${projectText(project)}`
      : `used for ${projectText(project)}`
    : de
      ? "verbraucht (ohne Projekt)"
      : "used (no project)";
  const warning = result.stock_warning?.trim();
  const head = `${quantity}× ${itemName} ${target} — ${totals}`;
  return warning ? `${head}. ${warning}` : head;
}
