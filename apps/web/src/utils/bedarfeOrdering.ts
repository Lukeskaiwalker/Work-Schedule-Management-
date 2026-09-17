import type { MaterialNeedRow, MaterialNeedSkipReason } from "../types/materialNeeds";
import { normalizeMaterialNeedStatus } from "./materials";

/**
 * Which selected needs would actually become order lines — the browser twin of
 * `_classify` in apps/api/app/services/material_need_orders.py.
 *
 * It exists so the bulk bar's count and the confirmation modal's preview
 * cannot disagree: one said "3 bestellbar" while the other listed two
 * positions, and the person confirming had no way to tell which was right.
 * The server remains the authority — its answer is shown after the fact — but
 * both sides of the preview come from here.
 */

/** Statuses that still describe missing material. */
const OPEN_STATUSES = new Set(["order", "ordered", "on_the_way"]);

/** The reason this row would be skipped, or null when it can be ordered. */
export function needSkipReason(row: MaterialNeedRow): MaterialNeedSkipReason | null {
  if (row.werkstatt_order_line_id != null) return "already_ordered";
  if (!OPEN_STATUSES.has(normalizeMaterialNeedStatus(row.status))) return "completed";
  if (row.material_catalog_item_id == null) return "no_catalog_item";
  if (row.supplier_id == null) return "no_supplier";
  return null;
}

export function canOrderNeed(row: MaterialNeedRow): boolean {
  return needSkipReason(row) === null;
}

export interface SupplierGroup {
  supplierId: number;
  supplierName: string;
  rows: MaterialNeedRow[];
}

export interface SkippedNeed {
  row: MaterialNeedRow;
  reason: MaterialNeedSkipReason;
}

/** The selection split the way the server will split it: one order per supplier. */
export function splitSelectionBySupplier(rows: readonly MaterialNeedRow[]): {
  groups: SupplierGroup[];
  skipped: SkippedNeed[];
} {
  const groups = new Map<number, SupplierGroup>();
  const skipped: SkippedNeed[] = [];
  for (const row of rows) {
    const reason = needSkipReason(row);
    if (reason !== null) {
      skipped.push({ row, reason });
      continue;
    }
    // needSkipReason has already proven this is a number.
    const supplierId = row.supplier_id as number;
    const existing = groups.get(supplierId);
    if (existing) existing.rows = [...existing.rows, row];
    else {
      groups.set(supplierId, {
        supplierId,
        supplierName: row.supplier_name ?? `#${supplierId}`,
        rows: [row],
      });
    }
  }
  return { groups: Array.from(groups.values()), skipped };
}
