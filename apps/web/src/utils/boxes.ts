/**
 * Shared construction-box (Baustellenkiste) presentation helpers.
 *
 * The status labels lived as a private copy inside WerkstattKistenPage and
 * CustomerBoxesCard; they move here now that a third surface (the task forms)
 * needs them, so the three cannot drift apart.
 */
import type { SelectableConstructionBox, Task } from "../types";

const STATUS_LABELS: Record<string, { de: string; en: string }> = {
  offen: { de: "Offen", en: "Open" },
  gepackt: { de: "Gepackt", en: "Packed" },
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
