/**
 * Shared construction-box (Baustellenkiste) presentation helpers.
 *
 * The status labels lived as a private copy inside WerkstattKistenPage and
 * CustomerBoxesCard; they move here now that a third surface (the task forms)
 * needs them, so the three cannot drift apart.
 */
import type { SelectableConstructionBox, Task } from "../types";

/**
 * ``gepackt`` reads "Gepackt – bereit" and not just "Gepackt" because the
 * state now means something a person can act on: the crate is packed, it
 * belongs to a customer, and it is standing in the workshop waiting to be
 * carried out. "Packed" alone said nothing about whether anybody still had to
 * do something with it.
 */
const STATUS_LABELS: Record<string, { de: string; en: string }> = {
  offen: { de: "Offen", en: "Open" },
  gepackt: { de: "Gepackt – bereit", en: "Packed – ready" },
  zugewiesen: { de: "Beim Kunden", en: "With customer" },
  zurueck: { de: "Zurück", en: "Returned" },
};

export function boxStatusLabel(status: string | null | undefined, de: boolean): string {
  if (!status) return "";
  const entry = STATUS_LABELS[status];
  if (!entry) return status;
  return de ? entry.de : entry.en;
}

/**
 * One option line in the picker: identity, then the facts that stop a wrong
 * pick — whether it is packed, how full it is, and (for another customer's
 * crate, which is only reachable by search) whose site it is sitting on.
 */
export function boxOptionLabel(box: SelectableConstructionBox, de: boolean): string {
  const parts = [`${box.box_number} — ${box.label}`, boxStatusLabel(box.status, de)];
  if (box.item_count > 0) {
    const unit = de
      ? box.item_count === 1
        ? "Position"
        : "Positionen"
      : box.item_count === 1
        ? "line"
        : "lines";
    parts.push(`${box.item_count} ${unit}`);
  }
  if (box.group === "other" && box.customer_name) {
    parts.push(box.customer_name);
  }
  return parts.filter(Boolean).join(" · ");
}

/**
 * How a task's crate reads in lists, the ICS export and the report prefill.
 *
 * Prefers the real link and falls back to the legacy free-typed number, so
 * tasks written before the picker existed still show what they always showed.
 * No language parameter: the output is identifiers only.
 */
export function taskBoxDisplay(task: Task): string | null {
  if (task.construction_box_number) {
    return task.construction_box_label
      ? `${task.construction_box_number} — ${task.construction_box_label}`
      : task.construction_box_number;
  }
  if (task.storage_box_number != null) return String(task.storage_box_number);
  return null;
}

/**
 * The crate on a task row: which one, and what is going on with it.
 *
 * "K3 — Kiste 3" alone left the office unable to tell a crate that is still
 * being packed from one that is already on the customer's site — the two ask
 * for completely different phone calls. One helper rather than the same
 * concatenation in three list pages.
 */
export function taskBoxSummary(task: Task, de: boolean): string | null {
  const display = taskBoxDisplay(task);
  if (!display) return null;
  const status = boxStatusLabel(task.construction_box_status, de);
  return status ? `${display} · ${status}` : display;
}
